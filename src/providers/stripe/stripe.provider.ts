/**
 * El adaptador de Stripe.
 *
 * Es el único archivo del servicio que habla con la API de Stripe, y sólo
 * devuelve tipos del contrato. Si mañana hay que cambiar de procesador, lo que
 * se escribe es otro archivo como éste: ni los casos de uso, ni el libro
 * contable, ni `urbont-api`, ni la app cambian.
 *
 * Dos decisiones heredadas de la auditoría de `urbont-api` y que aquí son
 * estructurales:
 *
 *  · **Los cobros no llevan el reparto dentro.** Nada de `transfer_data` ni de
 *    `application_fee_amount`. Todo entra a la plataforma y el reparto ocurre
 *    después, con una transferencia por beneficiario. Repartir en el cobro
 *    congelaba el importe antes de que existieran los recargos, y abría la
 *    puerta al doble pago cuando además se transfería aparte.
 *  · **Toda operación que mueve dinero lleva clave de idempotencia**, y la
 *    clave la pone quien llama, derivada del viaje y de la operación, nunca
 *    aleatoria: un reintento tiene que ser el mismo cobro, no otro.
 */

import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import type {
  Authorization,
  AuthorizeCommand,
  Capture,
  CaptureCommand,
  ChargeSavedCardCommand,
  IncreaseAuthorizationCommand,
  OnboardPayeeCommand,
  PayeeAccount,
  PayeeStatus,
  PaymentProvider,
  PresentChargeCommand,
  ProviderCapabilities,
  ProviderEvent,
  ProviderName,
  Refund,
  RefundCommand,
  SaveCardCommand,
  SavedCard,
  Transfer,
  TransferCommand,
  VoidCommand,
  WebhookRequest,
} from '../provider.port';
import {
  LIMITE_METADATA,
  LIMITE_VALOR_METADATA,
  PagoRechazadoError,
  ProcesadorFalloError,
} from '../provider.port';
import {
  estadoDeCobro,
  importeCapturado,
  moneda,
  motivoDeReembolso,
  referenciaDelCargo,
  traducirEvento,
} from './stripe.mapper';

export class FirmaInvalidaError extends Error {
  constructor(detalle: string) {
    super(`La firma del webhook de Stripe no es válida: ${detalle}`);
    this.name = 'FirmaInvalidaError';
  }
}

@Injectable()
export class StripeProvider implements PaymentProvider {
  readonly name: ProviderName = 'stripe';

  /**
   * Stripe sabe hacerlo casi todo, con una excepción que importa: **no reparte
   * en la captura**. Hay que transferir aparte, y eso es justo lo que el
   * registro consulta antes de elegirlo para una operación que lo exija.
   */
  readonly capabilities: ProviderCapabilities = {
    manualCapture: true,
    partialCapture: true,
    increaseAuthorization: true,
    savedCards: true,
    payouts: true,
    splitAtCapture: false,
    tapToPay: true,
    bankDebit: false,
    currencies: ['USD'],
  };

  private readonly log = new Logger(StripeProvider.name);

  constructor(
    private readonly stripe: Stripe,
    private readonly webhookSecrets: string[],
  ) {}

  // ── Cobrar ────────────────────────────────────────────────────────────────

  async authorize(cmd: AuthorizeCommand): Promise<Authorization> {
    return this.traduciendoErrores(async () => {
      const pi = await this.stripe.paymentIntents.create(
        {
          amount: cmd.amount,
          currency: cmd.currency.toLowerCase(),
          capture_method: cmd.hold ? 'manual' : 'automatic',
          payment_method_types: ['card'],
          ...(cmd.customerRef ? { customer: cmd.customerRef } : {}),
          ...(cmd.cardRef ? { payment_method: cmd.cardRef } : {}),
          metadata: this.metadatos(cmd),
        },
        { idempotencyKey: cmd.idempotencyKey },
      );

      return this.aAutorizacion(pi);
    });
  }

  /**
   * Lectura, no cobro: sin clave de idempotencia, porque no cambia nada.
   *
   * La usa el reintento del cobro para recuperar el `clientSecret`, que vive en
   * el procesador y no en el libro.
   */
  async getAuthorization(providerRef: string): Promise<Authorization> {
    return this.traduciendoErrores(async () => {
      return this.aAutorizacion(await this.stripe.paymentIntents.retrieve(providerRef));
    });
  }

  async capture(cmd: CaptureCommand): Promise<Capture> {
    return this.traduciendoErrores(async () => {
      const pi = await this.stripe.paymentIntents.capture(
        cmd.providerRef,
        cmd.amount !== undefined ? { amount_to_capture: cmd.amount } : {},
        { idempotencyKey: cmd.idempotencyKey },
      );

      return {
        providerRef: pi.id,
        provider: this.name,
        captured: importeCapturado(pi),
        currency: moneda(pi.currency),
        chargeRef: referenciaDelCargo(pi.latest_charge),
        raw: pi,
      };
    });
  }

  /**
   * Sube el importe de una autorización que todavía no se ha capturado.
   *
   * En Stripe no hay una operación «subir»: se actualiza el PaymentIntent. Sólo
   * se puede mientras el cobro sigue en `requires_capture`, que es justo cuando
   * lo necesitamos —al completar el viaje y antes de capturar—, y el banco
   * emisor puede rechazar el aumento, en cuyo caso Stripe lanza y el caso de uso
   * decide si captura lo que había.
   */
  async increaseAuthorization(cmd: IncreaseAuthorizationCommand): Promise<Authorization> {
    return this.traduciendoErrores(async () => {
      const pi = await this.stripe.paymentIntents.update(
        cmd.providerRef,
        { amount: cmd.amount },
        { idempotencyKey: cmd.idempotencyKey },
      );
      return this.aAutorizacion(pi);
    });
  }

  async voidAuthorization(cmd: VoidCommand): Promise<void> {
    return this.traduciendoErrores(async () => {
      await this.stripe.paymentIntents.cancel(cmd.providerRef, {}, {
        idempotencyKey: cmd.idempotencyKey,
      });
    });
  }

  async refund(cmd: RefundCommand): Promise<Refund> {
    return this.traduciendoErrores(async () => {
      const r = await this.stripe.refunds.create(
        {
          payment_intent: cmd.providerRef,
          ...(cmd.amount !== undefined ? { amount: cmd.amount } : {}),
          ...(cmd.reason ? { reason: motivoDeReembolso(cmd.reason) } : {}),
        },
        { idempotencyKey: cmd.idempotencyKey },
      );

      return {
        providerRef: cmd.providerRef,
        provider: this.name,
        refunded: r.amount,
        currency: moneda(r.currency),
        raw: r,
      };
    });
  }

  // ── Tarjetas guardadas ────────────────────────────────────────────────────

  async saveCard(cmd: SaveCardCommand): Promise<{ clientSecret: string; customerRef: string }> {
    return this.traduciendoErrores(async () => {
      const customerRef =
        cmd.customerRef ??
        (
          await this.stripe.customers.create(
            { metadata: { payer_id: cmd.payerId } },
            { idempotencyKey: `customer_${cmd.payerId}` },
          )
        ).id;

      const si = await this.stripe.setupIntents.create(
        { customer: customerRef, usage: 'off_session', payment_method_types: ['card'] },
        { idempotencyKey: cmd.idempotencyKey },
      );

      if (!si.client_secret) throw new Error('Stripe no devolvió client_secret al guardar la tarjeta');
      return { clientSecret: si.client_secret, customerRef };
    });
  }

  async listCards(customerRef: string): Promise<SavedCard[]> {
    return this.traduciendoErrores(async () => {
      const [metodos, cliente] = await Promise.all([
        this.stripe.paymentMethods.list({ customer: customerRef, type: 'card' }),
        this.stripe.customers.retrieve(customerRef),
      ]);

      const porDefecto =
        !('deleted' in cliente) && typeof cliente.invoice_settings?.default_payment_method === 'string'
          ? cliente.invoice_settings.default_payment_method
          : null;

      return metodos.data
        .filter((m) => m.card)
        .map((m) => ({
          providerRef: m.id,
          provider: this.name,
          brand: m.card!.brand,
          last4: m.card!.last4,
          expMonth: m.card!.exp_month,
          expYear: m.card!.exp_year,
          isDefault: m.id === porDefecto,
        }));
    });
  }

  async chargeSavedCard(cmd: ChargeSavedCardCommand): Promise<Capture> {
    return this.traduciendoErrores(async () => {
      const pi = await this.stripe.paymentIntents.create(
        {
          amount: cmd.amount,
          currency: cmd.currency.toLowerCase(),
          customer: cmd.customerRef,
          payment_method: cmd.cardRef,
          // El pasajero no está delante: es un cobro posterior al viaje.
          off_session: true,
          confirm: true,
          metadata: this.metadatos(cmd),
        },
        { idempotencyKey: cmd.idempotencyKey },
      );

      return {
        providerRef: pi.id,
        provider: this.name,
        captured: importeCapturado(pi),
        currency: moneda(pi.currency),
        chargeRef: referenciaDelCargo(pi.latest_charge),
        raw: pi,
      };
    });
  }

  // ── Beneficiarios y reparto ───────────────────────────────────────────────

  async onboardPayee(cmd: OnboardPayeeCommand): Promise<PayeeAccount> {
    return this.traduciendoErrores(async () => {
      const cuenta = await this.stripe.accounts.create(
        {
          country: cmd.country,
          ...(cmd.email ? { email: cmd.email } : {}),
          controller: {
            stripe_dashboard: { type: 'express' },
            losses: { payments: 'application' },
            fees: { payer: 'application' },
            requirement_collection: 'stripe',
          },
          capabilities: { transfers: { requested: true } },
          metadata: { payee_id: cmd.payeeId },
        },
        { idempotencyKey: cmd.idempotencyKey },
      );

      const enlace = await this.stripe.accountLinks.create({
        account: cuenta.id,
        type: 'account_onboarding',
        return_url: cmd.returnUrl,
        refresh_url: cmd.refreshUrl,
      });

      return {
        providerRef: cuenta.id,
        provider: this.name,
        status: this.estadoDeBeneficiario(cuenta),
        onboardingUrl: enlace.url,
      };
    });
  }

  async payeeStatus(payeeRef: string): Promise<PayeeStatus> {
    return this.traduciendoErrores(async () => {
      const cuenta = await this.stripe.accounts.retrieve(payeeRef);
      return this.estadoDeBeneficiario(cuenta);
    });
  }

  async transfer(cmd: TransferCommand): Promise<Transfer> {
    return this.traduciendoErrores(async () => {
      const t = await this.stripe.transfers.create(
        {
          amount: cmd.amount,
          currency: cmd.currency.toLowerCase(),
          destination: cmd.payeeRef,
          // Ata la transferencia al cargo del que sale. Sin esto falla con
          // `balance_insufficient` en cuanto los payouts automáticos barren el
          // saldo de la plataforma, que es lo que pasa cada madrugada.
          ...(cmd.sourceRef ? { source_transaction: cmd.sourceRef } : {}),
          ...(cmd.description ? { description: cmd.description } : {}),
          metadata: {
            ...(cmd.reference.rideId ? { ride_id: cmd.reference.rideId } : {}),
            ...(cmd.reference.beneficiaryId ? { beneficiary_id: cmd.reference.beneficiaryId } : {}),
          },
        },
        { idempotencyKey: cmd.idempotencyKey },
      );

      return {
        providerRef: t.id,
        provider: this.name,
        amount: t.amount,
        currency: moneda(t.currency),
        payeeRef: cmd.payeeRef,
        raw: t,
      };
    });
  }

  // ── Tap to Pay ────────────────────────────────────────────────────────────

  async presentCharge(cmd: PresentChargeCommand): Promise<Authorization> {
    const pi = await this.stripe.paymentIntents.create(
      {
        amount: cmd.amount,
        currency: cmd.currency.toLowerCase(),
        payment_method_types: ['card_present'],
        capture_method: cmd.hold ? 'manual' : 'automatic',
        metadata: { ...this.metadatos(cmd), presencial: 'true' },
      },
      { idempotencyKey: cmd.idempotencyKey },
    );

    return this.aAutorizacion(pi);
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────

  /**
   * Verifica la firma contra el cuerpo CRUDO y traduce.
   *
   * Se prueban varios secretos porque Stripe entrega los eventos de la cuenta y
   * los de Connect por endpoints distintos, cada uno con el suyo. Si ninguno
   * valida, se lanza: un aviso sin firma comprobada es un aviso de cualquiera.
   */
  async parseWebhook(req: WebhookRequest): Promise<ProviderEvent[]> {
    const firma = req.headers['stripe-signature'];
    if (!firma || typeof firma !== 'string') {
      throw new FirmaInvalidaError('no vino la cabecera stripe-signature');
    }
    if (this.webhookSecrets.length === 0) {
      throw new FirmaInvalidaError('el servicio no tiene configurado ningún secreto de webhook');
    }

    let ultimoError = '';
    for (const secreto of this.webhookSecrets) {
      try {
        const evento = this.stripe.webhooks.constructEvent(req.raw, firma, secreto);
        const traducido = traducirEvento(evento);
        if (!traducido) {
          this.log.debug(`Evento ignorado por irrelevante: ${evento.type}`);
          return [];
        }
        return [traducido];
      } catch (e) {
        ultimoError = e instanceof Error ? e.message : String(e);
      }
    }
    throw new FirmaInvalidaError(ultimoError);
  }

  // ── Interno ───────────────────────────────────────────────────────────────

  private aAutorizacion(pi: Stripe.PaymentIntent): Authorization {
    return {
      providerRef: pi.id,
      provider: this.name,
      status: estadoDeCobro(pi.status),
      amount: pi.amount,
      currency: moneda(pi.currency),
      ...(pi.client_secret ? { clientSecret: pi.client_secret } : {}),
      raw: pi,
    };
  }

  /**
   * Lo que se guarda en Stripe para poder auditar después.
   *
   * Nunca se usa para decidir importes: cuando se paga al chofer, la tasa de
   * comisión se lee de aquí para pagar con la que estaba vigente al cobrar, no
   * con la de hoy.
   */
  /**
   * Traduce lo que lanza Stripe a los errores del contrato.
   *
   * Sin esto, quien llama tendría que reconocer un `StripeCardError` para saber
   * que la tarjeta fue rechazada, y añadir Square obligaría a reconocer también
   * los suyos. Es el único sitio del servicio donde se nombran los errores de
   * Stripe, igual que es el único donde se nombra su SDK.
   *
   * La distinción que importa al otro lado es una sola: **¿tiene sentido
   * reintentar?** Un `card_declined` no; un 500 de Stripe, sí.
   */
  private async traduciendoErrores<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Stripe.errors.StripeCardError) {
        throw new PagoRechazadoError(e.code ?? 'card_declined', e.message, this.name);
      }
      // Petición inválida por nuestra parte: reintentarla da el mismo error, y
      // además suele ser un cobro en un estado que no admite la operación.
      if (e instanceof Stripe.errors.StripeInvalidRequestError) {
        throw new PagoRechazadoError(e.code ?? 'invalid_request', e.message, this.name);
      }
      if (e instanceof Stripe.errors.StripeError) {
        throw new ProcesadorFalloError(this.name, `Stripe falló: ${e.message}`, e);
      }
      throw e;
    }
  }

  private metadatos(cmd: AuthorizeCommand): Record<string, string> {
    return {
      kind: cmd.kind,
      ...(cmd.reference.rideId ? { ride_id: cmd.reference.rideId } : {}),
      ...(cmd.reference.payerId ? { payer_id: cmd.reference.payerId } : {}),
      ...(cmd.taxAmount !== undefined ? { tax_amount_cents: String(cmd.taxAmount) } : {}),
      // La traza de quien llama va al final, pero NO puede pisar lo de arriba:
      // `kind` y `ride_id` son los que después buscan la conciliación y el
      // panel, y un `ride_id` equivocado en el cobro es un cobro perdido.
      ...this.trazaAcotada(cmd.metadata),
    };
  }

  /**
   * La traza de quien llama, recortada a lo que el procesador acepta.
   *
   * Stripe rechaza la petición entera si se pasa de 50 claves o 500 caracteres
   * por valor. Recortar aquí convierte un cobro fallido en una traza incompleta,
   * que es infinitamente mejor: el aviso queda en el registro.
   */
  private trazaAcotada(metadata?: Record<string, string>): Record<string, string> {
    if (!metadata) return {};
    const reservadas = new Set(['kind', 'ride_id', 'payer_id', 'tax_amount_cents']);
    const salida: Record<string, string> = {};
    for (const [clave, valor] of Object.entries(metadata)) {
      if (reservadas.has(clave)) continue;
      if (Object.keys(salida).length >= LIMITE_METADATA) {
        this.log.warn(`Traza recortada: más de ${LIMITE_METADATA} claves en la metadata del cobro.`);
        break;
      }
      salida[clave] = String(valor ?? '').slice(0, LIMITE_VALOR_METADATA);
    }
    return salida;
  }

  private estadoDeBeneficiario(cuenta: Stripe.Account): PayeeStatus {
    // `transfers: 'active'` es lo único que de verdad dice que se le puede
    // pagar. `details_submitted` sólo dice que rellenó el formulario, y usarlo
    // dejó en urbont-api a choferes sin cobrar durante meses.
    const transferencias = cuenta.capabilities?.transfers;
    if (transferencias === 'active') return 'active';
    if (cuenta.requirements?.disabled_reason) return 'restricted';
    if (transferencias === 'pending' || transferencias === 'inactive') return 'pending';
    return 'pending';
  }
}
