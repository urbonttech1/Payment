/**
 * El adaptador de Square.
 *
 * Es el segundo, y escribirlo era el objetivo de la fase 7: comprobar que el
 * contrato aguanta un procesador que funciona distinto. Aguanta. Lo valioso no
 * es el archivo, son las cuatro diferencias que sólo aparecen al escribirlo, y
 * que están declaradas en `capabilities` en vez de descubrirse en producción:
 *
 *  1. **Square no sabe pagar a terceros.** No hay transferencias como las de
 *     Stripe Connect: el reparto iría DENTRO del cobro (`appFeeMoney`), con el
 *     chofer como vendedor y URBONT cobrando su comisión. Pero el contrato no
 *     lleva beneficiario en el cobro —a propósito: el destino del dinero no
 *     viaja en la petición— así que por aquí ese reparto no se puede hacer.
 *     Por eso `payouts: false` y `splitAtCapture: false`, y `transfer()` lanza
 *     en voz alta: un cobro de Square no se puede repartir con el motor de hoy,
 *     y el reparto se queda fallido a la vista en vez de darse por pagado.
 *
 *  2. **El orden del cobro es el contrario.** Stripe crea el cobro y la app lo
 *     confirma con el `clientSecret`; Square exige que la app tokenice la
 *     tarjeta PRIMERO y manda ese token (`sourceId`) al crear el pago. Por eso
 *     `authorize` sin `cardRef` falla diciendo exactamente eso, en vez de crear
 *     algo que nadie podrá confirmar. **La app de URBONT no manda ese token
 *     hoy**, así que el cobro del viaje por Square necesita cambio de app.
 *
 *  3. **Guardar una tarjeta también va al revés.** `cards.create` necesita el
 *     token de la app, así que no hay nada que la app confirme después: la
 *     tarjeta queda guardada en la misma llamada. Por eso el contrato devuelve
 *     una unión y no un `clientSecret`, que es puro Stripe.
 *
 *     ⚠️ Con `savedCards: true` se activa una deuda que hasta ahora no podía
 *     hacer daño: **una tarjeta pertenece al procesador que la guardó**, y el
 *     registro todavía elige por capacidad, no por dueño. Con dos procesadores
 *     que guardan tarjetas, una de Square puede acabar presentada a Stripe.
 *     Hay que enrutar por dueño antes de encender los dos a la vez (ver la
 *     nota de `chargeSavedCard`).
 *
 *  4. **Capturar y subir el importe son la misma llamada.** Square no acepta
 *     importe al completar un pago: lo que se hace es actualizar el importe
 *     aprobado y completar después. Sirve igual para bajar (cancelación con
 *     penalización) y para subir (el cargo por espera).
 *
 * Lo que sí hace igual: retener y capturar, reembolsar, listar el extracto,
 * verificar sus avisos y decir si sus credenciales valen. Pasa la suite de
 * conformidad entera.
 */

import { Injectable, Logger } from '@nestjs/common';
import { SquareClient, SquareError, WebhooksHelper } from 'square';
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
  ProviderCapabilities,
  ProviderEvent,
  ProviderName,
  Refund,
  RefundCommand,
  ResultadoDeGuardado,
  SaveCardCommand,
  SavedCard,
  SettlementCharge,
  Transfer,
  TransferCommand,
  VoidCommand,
  WebhookRequest,
} from '../provider.port';
import {
  FirmaDeWebhookInvalidaError,
  PagoRechazadoError,
  ProcesadorFalloError,
} from '../provider.port';
import {
  centavos,
  claveDeSquare,
  dinero,
  estadoDeCobro,
  moneda,
  traducirEvento,
  type EventoDeSquare,
} from './square.mapper';

/**
 * Lo que este procesador no sabe hacer, dicho sin rodeos.
 *
 * Existe para que la diferencia entre «Square no puede» y «se nos olvidó» no
 * haya que adivinarla leyendo un error del SDK: lo que llega al libro es un
 * reparto fallido con el motivo escrito.
 */
export class OperacionNoSoportadaError extends Error {
  constructor(
    public readonly provider: ProviderName,
    operacion: string,
    porque: string,
  ) {
    super(`'${provider}' no sabe ${operacion}: ${porque}`);
    this.name = 'OperacionNoSoportadaError';
  }
}

export interface OpcionesDeSquare {
  /** La localización del vendedor. Square la exige en cada cobro. */
  locationId: string;
  /** La clave de firma del webhook y la URL EXACTA a la que Square entrega. */
  webhookSignatureKey?: string;
  webhookNotificationUrl?: string;
}

@Injectable()
export class SquareProvider implements PaymentProvider {
  readonly name: ProviderName = 'square';

  /**
   * Lo que este adaptador sabe hacer, no lo que Square sabría hacer.
   *
   * La diferencia importa: Square tiene Tap to Pay y tiene reparto en el cobro,
   * y aquí van en `false` porque por este adaptador no se pueden usar. Una
   * capacidad declarada de más es peor que una de menos: el registro elegiría
   * Square para una operación que acabaría fallando a mitad del cobro.
   */
  readonly capabilities: ProviderCapabilities = {
    manualCapture: true,
    partialCapture: true,
    increaseAuthorization: true,
    // Puede, pero sólo con el token que la app genera: ver `saveCard`.
    savedCards: true,
    payouts: false,
    splitAtCapture: false,
    tapToPay: false,
    bankDebit: false,
    currencies: ['USD'],
  };

  private readonly log = new Logger(SquareProvider.name);

  constructor(
    private readonly square: SquareClient,
    private readonly opciones: OpcionesDeSquare,
  ) {}

  // ── Cobrar ────────────────────────────────────────────────────────────────

  async authorize(cmd: AuthorizeCommand): Promise<Authorization> {
    if (!cmd.cardRef) {
      throw new OperacionNoSoportadaError(
        this.name,
        'crear un cobro sin tarjeta',
        'necesita el token que la app genera al tokenizar la tarjeta, y lo recibe en cardRef; ' +
          'Square no tiene un cobro que la app confirme después, como el clientSecret de Stripe',
      );
    }
    return this.cobrar(cmd, cmd.cardRef);
  }

  /**
   * Cobra contra una tarjeta ya guardada **en Square**.
   *
   * ⚠️ **Esto ya no es seguro con los dos procesadores montados a la vez.**
   *
   * La regla es que **la tarjeta pertenece al procesador que la guardó**. El
   * registro todavía elige el procesador de un cobro con tarjeta guardada por
   * capacidad (`paraCobroNuevo(['savedCards'])`), no por quién la guardó.
   * Mientras Square tenía `savedCards: false` eso no podía hacer daño: no había
   * tarjetas suyas. Desde que sabe guardarlas, sí lo hay — una tarjeta de
   * Square puede acabar presentada a Stripe, y el cobro se cae.
   *
   * Lo que falta: guardar el procesador de cada tarjeta y enrutar por él. Hasta
   * entonces, no montar Stripe y Square guardando tarjetas al mismo tiempo.
   */
  async chargeSavedCard(cmd: ChargeSavedCardCommand): Promise<Authorization> {
    return this.cobrar(cmd, cmd.cardRef);
  }

  private async cobrar(cmd: AuthorizeCommand, sourceId: string): Promise<Authorization> {
    return this.traduciendoErrores(async () => {
      const { payment } = await this.square.payments.create({
        sourceId,
        idempotencyKey: claveDeSquare(cmd.idempotencyKey),
        amountMoney: dinero(cmd.amount, cmd.currency),
        locationId: this.opciones.locationId,
        // `false` retiene y se cobra después; `true` cobra en el acto. Es el
        // mismo interruptor que `capture_method` en Stripe, escrito al revés.
        autocomplete: !cmd.hold,
        ...(cmd.customerRef ? { customerId: cmd.customerRef } : {}),
        // Lo único que Square guarda como traza nuestra. No tiene un mapa de
        // metadata como Stripe, así que `cmd.metadata` NO cabe aquí: lo que
        // `urbont-api` lee del cobro para pagar al chofer (`commission_rate`,
        // `tax_calculation_id`) no existe en un cobro de Square, y por eso ese
        // reparto tiene que venir del libro y no del procesador.
        ...(cmd.reference.rideId ? { referenceId: cmd.reference.rideId.slice(0, 40) } : {}),
        ...(cmd.description ? { note: cmd.description.slice(0, 500) } : {}),
      });

      if (cmd.metadata && Object.keys(cmd.metadata).length > 0) {
        this.log.debug(
          `Square no guarda metadata: ${Object.keys(cmd.metadata).join(', ')} se queda en el libro (${cmd.idempotencyKey}).`,
        );
      }

      return this.aAutorizacion(payment);
    });
  }

  /** Lectura, no cobro: sin clave de idempotencia, porque no cambia nada. */
  async getAuthorization(providerRef: string): Promise<Authorization> {
    return this.traduciendoErrores(async () => {
      const { payment } = await this.square.payments.get({ paymentId: providerRef });
      return this.aAutorizacion(payment);
    });
  }

  /**
   * Cobra lo retenido, o menos.
   *
   * `CompletePayment` no acepta importe, así que cobrar menos de lo aprobado
   * —una cancelación con penalización— se hace en dos pasos: se baja el importe
   * aprobado y se completa. Quien llama ya se encarga de no pedir más de lo
   * autorizado (`PaymentsService.capturar`), y subir tiene su propio método.
   */
  async capture(cmd: CaptureCommand): Promise<Capture> {
    return this.traduciendoErrores(async () => {
      if (cmd.amount !== undefined) {
        await this.square.payments.update({
          paymentId: cmd.providerRef,
          payment: { amountMoney: dinero(cmd.amount, 'USD') },
          // Ajustar a 9000 y ajustar a 8000 son dos operaciones distintas: el
          // importe entra en la clave o el procesador devolvería el primer
          // ajuste al pedir el segundo.
          idempotencyKey: claveDeSquare(`${cmd.idempotencyKey}_ajuste_${cmd.amount}`),
        });
      }

      const { payment } = await this.square.payments.complete(
        { paymentId: cmd.providerRef },
        // Square identifica esta operación por el id del pago, que ya salió de
        // nuestra clave al crearlo: completar dos veces no cobra dos veces. La
        // clave viaja de todas formas, en la cabecera, porque es lo que hace
        // que una llamada se pueda rastrear desde el libro hasta el registro de
        // peticiones de Square.
        { headers: { 'Idempotency-Key': claveDeSquare(cmd.idempotencyKey) } },
      );

      const capturado = centavos(payment?.totalMoney?.amount ?? payment?.amountMoney?.amount);
      if (cmd.amount !== undefined && cmd.amount !== capturado) {
        this.log.warn(
          `Se pidió capturar ${cmd.amount} y se cobraron ${capturado} (${cmd.providerRef}).`,
        );
      }

      return {
        providerRef: payment?.id ?? cmd.providerRef,
        provider: this.name,
        captured: capturado,
        currency: moneda(payment?.amountMoney?.currency),
        // En Square el pago ES el cargo: no hay dos objetos como en Stripe.
        ...(payment?.id ? { chargeRef: payment.id } : {}),
        raw: payment,
      };
    });
  }

  /**
   * Sube el importe de una autorización que todavía no se ha cobrado.
   *
   * Es el cargo por espera: el viaje se autoriza al reservar y el total sólo se
   * sabe al terminar. Square lo hace con el mismo `UpdatePayment` que sirve para
   * bajarlo, y el banco emisor puede negarse; entonces esto lanza y
   * `PaymentsService` captura lo que había, que es la decisión correcta: cobrar
   * de menos es un problema, no cobrar es peor.
   */
  async increaseAuthorization(cmd: IncreaseAuthorizationCommand): Promise<Authorization> {
    return this.traduciendoErrores(async () => {
      const { payment } = await this.square.payments.update({
        paymentId: cmd.providerRef,
        // `amount` es el NUEVO TOTAL, no el incremento: lo dice el contrato y
        // es también lo que Square espera.
        payment: { amountMoney: dinero(cmd.amount, 'USD') },
        idempotencyKey: claveDeSquare(cmd.idempotencyKey),
      });
      return this.aAutorizacion(payment);
    });
  }

  async voidAuthorization(cmd: VoidCommand): Promise<void> {
    await this.traduciendoErrores(async () => {
      await this.square.payments.cancel(
        { paymentId: cmd.providerRef },
        { headers: { 'Idempotency-Key': claveDeSquare(cmd.idempotencyKey) } },
      );
    });
  }

  async refund(cmd: RefundCommand): Promise<Refund> {
    return this.traduciendoErrores(async () => {
      // Square exige el importe: para devolverlo todo hay que preguntar cuánto
      // entró. Es una lectura, no mueve dinero.
      const total = cmd.amount ?? (await this.importeDe(cmd.providerRef));

      const { refund } = await this.square.refunds.refundPayment({
        idempotencyKey: claveDeSquare(cmd.idempotencyKey),
        paymentId: cmd.providerRef,
        amountMoney: dinero(total, 'USD'),
        ...(cmd.reason ? { reason: cmd.reason } : {}),
      });

      return {
        providerRef: refund?.id ?? cmd.providerRef,
        provider: this.name,
        refunded: centavos(refund?.amountMoney?.amount),
        currency: moneda(refund?.amountMoney?.currency),
        raw: refund,
      };
    });
  }

  private async importeDe(paymentId: string): Promise<number> {
    const { payment } = await this.square.payments.get({ paymentId });
    return centavos(payment?.totalMoney?.amount ?? payment?.amountMoney?.amount);
  }

  // ── Tarjetas guardadas ────────────────────────────────────────────────────

  /**
   * Guarda una tarjeta que **la app ya tokenizó**.
   *
   * Aquí está la diferencia de fondo con Stripe: no hay nada que la app
   * confirme después. Square necesita el token por delante y, con él, la
   * tarjeta queda guardada en la misma llamada. Por eso el contrato devuelve
   * una unión y no un `clientSecret`: inventar uno aquí sería mentir.
   *
   * Sin `cardToken` se niega en voz alta en vez de crear un cliente huérfano:
   * un `customers.create` sin tarjeta detrás deja basura en Square que nadie
   * vuelve a mirar.
   */
  async saveCard(cmd: SaveCardCommand): Promise<ResultadoDeGuardado> {
    if (!cmd.cardToken) {
      throw new OperacionNoSoportadaError(
        this.name,
        'guardar una tarjeta sin token',
        'la app tiene que tokenizar con el SDK de Square y mandar ese token en cardToken; ' +
          `Square no tiene un secreto que la app confirme después (pagador ${cmd.payerId})`,
      );
    }

    return this.traduciendoErrores(async () => {
      const customerRef =
        cmd.customerRef ??
        (
          await this.square.customers.create({
            referenceId: cmd.payerId,
            // La clave sale del pagador y no es aleatoria: un reintento tiene
            // que encontrar al mismo cliente, no crear otro.
            idempotencyKey: claveDeSquare(`customer_${cmd.payerId}`),
            // Square EXIGE al menos uno de given_name, family_name,
            // company_name, email_address o phone_number. Con sólo
            // `referenceId` responde 400 y la tarjeta no se guarda nunca.
            // El correo es lo que hace la ficha reconocible en su panel; sin
            // él se pone un nombre fijo, que cumple el requisito y deja la
            // identificación real en `referenceId`.
            ...(cmd.payerEmail ? { emailAddress: cmd.payerEmail } : { companyName: 'URBONT' }),
          })
        ).customer?.id;

      if (!customerRef) throw new Error('Square no devolvió el cliente al guardarlo');

      const r = await this.square.cards.create({
        idempotencyKey: claveDeSquare(cmd.idempotencyKey),
        sourceId: cmd.cardToken!,
        card: { customerId: customerRef },
      });

      const c = r.card;
      if (!c?.id) throw new Error('Square no devolvió la tarjeta guardada');

      return {
        modo: 'guardada' as const,
        customerRef,
        card: {
          providerRef: c.id,
          provider: this.name,
          brand: c.cardBrand ?? 'unknown',
          last4: c.last4 ?? '',
          expMonth: Number(c.expMonth ?? 0),
          expYear: Number(c.expYear ?? 0),
          // Square no tiene concepto de tarjeta por defecto: quien la elige es
          // URBONT, en su propia tabla. Decir `true` aquí sería inventarlo.
          isDefault: false,
        },
      };
    });
  }

  /**
   * Busca al cliente por la referencia de URBONT que se puso al crearlo.
   *
   * Es lo que permite listar las tarjetas de un pagador sin que guardemos el
   * identificador de Square: `saveCard` graba `referenceId: payerId`, y por ahí
   * se vuelve. Devuelve `null` —y no lanza— cuando no hay ninguno, porque «este
   * pasajero todavía no tiene tarjetas» es una respuesta normal, no un fallo.
   */
  async findCustomer(payerId: string): Promise<string | null> {
    return this.traduciendoErrores(async () => {
      const r = await this.square.customers.search({
        query: { filter: { referenceId: { exact: payerId } } },
        // `bigint` y no `number`: el SDK lo exige y un número suelto revienta
        // con «Expected bigint», que no se parece a un problema de búsqueda.
        limit: 1n,
      });
      return r.customers?.[0]?.id ?? null;
    });
  }

  async listCards(customerRef: string): Promise<SavedCard[]> {
    return this.traduciendoErrores(async () => {
      const pagina = await this.square.cards.list({ customerId: customerRef });
      return (pagina.data ?? [])
        .filter((c) => c.enabled !== false)
        .map((c) => ({
          providerRef: c.id ?? '',
          provider: this.name,
          brand: c.cardBrand ?? 'unknown',
          last4: c.last4 ?? '',
          expMonth: Number(c.expMonth ?? 0),
          expYear: Number(c.expYear ?? 0),
          // Square no marca ninguna como preferida: eso lo decide URBONT.
          isDefault: false,
        }));
    });
  }

  // ── Beneficiarios y reparto ───────────────────────────────────────────────

  /**
   * Square no tiene nada parecido a Stripe Connect.
   *
   * Un vendedor se da de alta autorizando la aplicación por OAuth desde SU
   * cuenta de Square, no por API, y después el dinero no se le transfiere: se le
   * deja directamente al cobrar, quedándose URBONT su comisión con
   * `appFeeMoney`. Las tres lanzan porque fingir que funcionan dejaría a un
   * chofer esperando un pago que nadie va a hacer, que es exactamente el fallo
   * que esta capa existe para no repetir.
   */
  async onboardPayee(cmd: OnboardPayeeCommand): Promise<PayeeAccount> {
    throw new OperacionNoSoportadaError(
      this.name,
      'dar de alta a un beneficiario',
      `cada chofer autoriza la aplicación por OAuth desde su propia cuenta de Square (${cmd.payeeId})`,
    );
  }

  async payeeStatus(payeeRef: string): Promise<PayeeStatus> {
    throw new OperacionNoSoportadaError(
      this.name,
      'consultar el estado de un beneficiario',
      `depende de la autorización OAuth del vendedor, no de una cuenta nuestra (${payeeRef})`,
    );
  }

  async transfer(cmd: TransferCommand): Promise<Transfer> {
    throw new OperacionNoSoportadaError(
      this.name,
      'transferir a un beneficiario',
      'el reparto de Square va dentro del cobro (appFeeMoney) y no en una transferencia posterior, ' +
        `y el contrato no lleva beneficiario en el cobro (${cmd.payeeRef})`,
    );
  }

  // ── Credenciales ──────────────────────────────────────────────────────────

  /** Una lectura barata y autenticada: si contesta, la clave vale. */
  async ping(): Promise<void> {
    await this.traduciendoErrores(async () => {
      await this.square.locations.list();
    });
  }

  // ── Conciliación ──────────────────────────────────────────────────────────

  async listCharges(desde: Date, hasta: Date, limite: number): Promise<SettlementCharge[]> {
    return this.traduciendoErrores(async () => {
      const pagina = await this.square.payments.list({
        beginTime: desde.toISOString(),
        endTime: hasta.toISOString(),
        locationId: this.opciones.locationId,
        limit: Math.min(100, limite),
      });

      const salida: SettlementCharge[] = [];
      for await (const pago of pagina) {
        if ((pago.status ?? '').toUpperCase() !== 'COMPLETED') continue;
        salida.push({
          chargeRef: pago.id ?? '',
          providerRef: pago.id ?? null,
          // Lo que de verdad quedó: lo cobrado menos lo devuelto. Es el único
          // número con el que se puede cuadrar.
          netCents: centavos(pago.totalMoney?.amount) - centavos(pago.refundedMoney?.amount),
          currency: moneda(pago.amountMoney?.currency),
          createdAt: pago.createdAt ? new Date(pago.createdAt) : new Date(),
        });
        if (salida.length >= limite) break;
      }
      return salida;
    });
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────

  /**
   * Verifica la firma contra el cuerpo CRUDO y traduce.
   *
   * Square firma incluyendo **la URL de entrega**, así que tiene que coincidir
   * carácter por carácter con la que está puesta en el panel de Square. Es el
   * motivo número uno de que las firmas de Square no cuadren, y por eso la URL
   * es configuración y no una constante escondida en el código.
   */
  async parseWebhook(req: WebhookRequest): Promise<ProviderEvent[]> {
    const cabecera = this.unaCabecera(req, 'x-square-hmacsha256-signature');
    if (!cabecera) throw new FirmaDeWebhookInvalidaError(this.name, 'no vino la cabecera de firma');

    if (!this.opciones.webhookSignatureKey || !this.opciones.webhookNotificationUrl) {
      throw new FirmaDeWebhookInvalidaError(
        this.name,
        'faltan la clave de firma o la URL de entrega en la configuración de Square',
      );
    }

    const cuerpo = req.raw.toString('utf8');
    const valida = await WebhooksHelper.verifySignature({
      requestBody: cuerpo,
      signatureHeader: cabecera,
      signatureKey: this.opciones.webhookSignatureKey,
      notificationUrl: this.opciones.webhookNotificationUrl,
    });
    if (!valida) throw new FirmaDeWebhookInvalidaError(this.name, 'la firma no cuadra');

    let evento: EventoDeSquare;
    try {
      evento = JSON.parse(cuerpo) as EventoDeSquare;
    } catch {
      throw new FirmaDeWebhookInvalidaError(this.name, 'el cuerpo no es JSON');
    }

    const traducido = traducirEvento(evento);
    if (!traducido) {
      this.log.debug(`Aviso de Square ignorado por irrelevante: ${evento.type}`);
      return [];
    }

    return [
      {
        eventId: evento.event_id ?? '',
        provider: this.name,
        type: traducido.tipo,
        providerRef: traducido.providerRef,
        ...(traducido.objectRef ? { objectRef: traducido.objectRef } : {}),
        ...(traducido.amount !== undefined ? { amount: traducido.amount } : {}),
        occurredAt: evento.created_at ? new Date(evento.created_at) : new Date(),
        raw: evento,
      },
    ];
  }

  // ── Interno ───────────────────────────────────────────────────────────────

  private unaCabecera(req: WebhookRequest, nombre: string): string | undefined {
    const v = req.headers[nombre] ?? req.headers[nombre.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  }

  private aAutorizacion(payment: {
    id?: string;
    status?: string;
    amountMoney?: { amount?: bigint | null; currency?: string };
  } | undefined): Authorization {
    return {
      providerRef: payment?.id ?? '',
      provider: this.name,
      status: estadoDeCobro(payment?.status),
      amount: centavos(payment?.amountMoney?.amount),
      currency: moneda(payment?.amountMoney?.currency),
      ...(payment?.id ? { chargeRef: payment.id } : {}),
      raw: payment,
    };
  }

  /**
   * Traduce lo que lanza Square a los errores del contrato.
   *
   * La distinción que importa al otro lado es una sola: **¿tiene sentido
   * reintentar por otro camino?** Una tarjeta rechazada no —pedirle dos veces el
   * no al banco es cobrarle dos veces al pasajero si acaba diciendo sí—; un
   * fallo de Square sí.
   *
   * Un `INVALID_REQUEST_ERROR` se trata como fallo del procesador a propósito:
   * eso es un error nuestro, y decirle al pasajero que su tarjeta fue rechazada
   * cuando el problema es nuestro código es mentirle. Como fallo, quien llama se
   * cae al camino de siempre y el cobro sale.
   */
  private async traduciendoErrores<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof OperacionNoSoportadaError || e instanceof FirmaDeWebhookInvalidaError) throw e;

      if (e instanceof SquareError) {
        const primero = e.errors?.[0];
        const categoria = String(primero?.category ?? '').toUpperCase();
        const detalle = primero?.detail ?? e.message;

        if (categoria === 'PAYMENT_METHOD_ERROR' || categoria === 'REFUND_ERROR') {
          throw new PagoRechazadoError(String(primero?.code ?? 'card_declined'), detalle, this.name);
        }
        throw new ProcesadorFalloError(this.name, `Square falló (${categoria || e.statusCode || 'sin categoría'}): ${detalle}`, e);
      }

      throw new ProcesadorFalloError(
        this.name,
        `Square falló: ${e instanceof Error ? e.message : String(e)}`,
        e,
      );
    }
  }
}
