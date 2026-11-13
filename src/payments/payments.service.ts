/**
 * Los casos de uso del dinero: autorizar, capturar, anular y reembolsar.
 *
 * Aquí es donde se cumplen las dos reglas del servicio:
 *
 *  1. **Un reintento no cobra dos veces.** Antes de llamar al procesador se
 *     apunta la intención en el libro, con la clave de idempotencia como
 *     restricción única. Si la fila ya existía y ya tenía referencia del
 *     procesador, se devuelve aquélla; del procesador sólo se vuelve a *leer*,
 *     nunca a cobrar.
 *  2. **Una operación sobre un cobro existente vuelve al procesador que lo
 *     originó.** No al que esté por defecto hoy: al que guarda esa fila.
 *
 * El orden importa y no es casual: primero el libro, después el procesador. Al
 * revés, un cobro que sale bien pero cuya fila no se llega a escribir es dinero
 * cobrado del que no queda rastro.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProviderRegistry } from '../providers/provider.registry';
import {
  TRANSACTIONS_REPOSITORY,
  type Transaction,
  type TransactionsRepository,
} from '../ledger/transactions.repository';
import { ENTRIES_REPOSITORY, type EntriesRepository } from '../ledger/entries.repository';
import { asientosDeReembolso } from '../ledger/asientos';
import type {
  Authorization,
  Capture,
  Cents,
  ChargeKind,
  Currency,
  PaymentProvider,
  ProviderName,
  Refund,
  TerminalSession,
} from '../providers/provider.port';
import { PagoNoAdoptableError } from '../providers/provider.port';

export class TransaccionNoEncontradaError extends Error {
  constructor(referencia: string) {
    super(`No hay ninguna transacción con la referencia ${referencia}`);
    this.name = 'TransaccionNoEncontradaError';
  }
}

export class EstadoInesperadoError extends Error {
  constructor(public readonly detalle: string) {
    super(detalle);
    this.name = 'EstadoInesperadoError';
  }
}

export interface PeticionDeCobro {
  /** Derivada del viaje y de la operación, nunca aleatoria. */
  idempotencyKey: string;
  kind: ChargeKind;
  amountCents: Cents;
  currency: Currency;
  taxCents?: Cents;
  /** `true` retiene (reservas); `false` cobra en el acto. */
  hold: boolean;
  /** `false` cuando el pasajero está delante y puede autenticarse. */
  offSession?: boolean;
  /** Lo que verá el pasajero en el extracto de su tarjeta. */
  description?: string;
  rideId?: string;
  payerId?: string;
  customerRef?: string;
  cardRef?: string;
  /** Traza que viaja al procesador y no decide nada. Ver `AuthorizeCommand`. */
  metadata?: Record<string, string>;
}

@Injectable()
export class PaymentsService {
  private readonly log = new Logger(PaymentsService.name);

  constructor(
    private readonly registry: ProviderRegistry,
    @Inject(TRANSACTIONS_REPOSITORY) private readonly transacciones: TransactionsRepository,
    @Inject(ENTRIES_REPOSITORY) private readonly asientos: EntriesRepository,
  ) {}

  /**
   * Autoriza (o cobra) un importe.
   *
   * El importe llega ya resuelto por quien llama; este servicio no lo discute,
   * pero tampoco lo acepta de un cliente: `urbont-api` lo calcula contra el
   * viaje antes de pedirlo.
   */
  async autorizar(p: PeticionDeCobro): Promise<{ transaccion: Transaction; autorizacion: Authorization | null }> {
    // Cobrar contra una tarjeta guardada es otra capacidad, y no todos los
    // procesadores la tienen: el registro elige por operación, no sólo por
    // procesador por defecto.
    const conTarjetaGuardada = Boolean(p.cardRef && p.customerRef);
    const provider = this.registry.paraCobroNuevo([
      ...(p.hold ? (['manualCapture'] as const) : []),
      ...(conTarjetaGuardada ? (['savedCards'] as const) : []),
    ]);

    const { transaccion, yaExistia } = await this.transacciones.crearSiNoExiste({
      idempotencyKey: p.idempotencyKey,
      provider: provider.name,
      kind: p.kind,
      rideId: p.rideId ?? null,
      payerId: p.payerId ?? null,
      amountCents: p.amountCents,
      taxCents: p.taxCents ?? 0,
      currency: p.currency,
    });

    // Un reintento de algo que ya se cobró: se devuelve lo que hay y **no se
    // vuelve a cobrar**. Sí se relee el cobro en el procesador, que es una
    // lectura y no mueve dinero: el `clientSecret` con el que la app confirma la
    // tarjeta vive allí y no en el libro, así que sin releerlo el reintento
    // devolvería un cobro sin secreto y el pasajero se quedaría mirando una
    // pantalla que no avanza. Si la lectura falla, se devuelve el cobro igual.
    if (yaExistia && transaccion.providerRef) {
      this.log.log(`Reintento de ${p.idempotencyKey}: ya existe ${transaccion.providerRef}, no se cobra otra vez.`);
      let autorizacion: Authorization | null = null;
      try {
        autorizacion = await this.registry
          .paraCobroExistente(transaccion.provider)
          .getAuthorization(transaccion.providerRef);
      } catch (e) {
        this.log.warn(
          `No se pudo releer ${transaccion.providerRef} en '${transaccion.provider}': ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return { transaccion, autorizacion };
    }

    const comando = {
      idempotencyKey: p.idempotencyKey,
      kind: p.kind,
      amount: p.amountCents,
      currency: p.currency,
      hold: p.hold,
      taxAmount: p.taxCents,
      customerRef: p.customerRef,
      cardRef: p.cardRef,
      offSession: p.offSession,
      description: p.description,
      reference: { rideId: p.rideId, payerId: p.payerId },
      metadata: p.metadata,
    };

    try {
      const autorizacion = conTarjetaGuardada
        ? await provider.chargeSavedCard({
            ...comando,
            cardRef: p.cardRef as string,
            customerRef: p.customerRef as string,
          })
        : await provider.authorize(comando);

      const actualizada = await this.anotarElResultado(transaccion, autorizacion);
      return { transaccion: actualizada, autorizacion };
    } catch (e) {
      const codigo = this.codigoDeError(e);
      await this.transacciones.marcarFallida(transaccion.id, codigo);
      throw e;
    }
  }

  /**
   * Apunta en el libro lo que de verdad pasó.
   *
   * **Crear un cobro no es cobrarlo.** El banco puede pedir autenticación y
   * dejarlo en `requires_action` sin que nadie lance un error; dar eso por
   * cobrado es lo que mostró una propina que ningún pasajero pagó. Así que el
   * estado del libro sale del estado del procesador, uno a uno:
   *
   *  · `captured`        → cobrado, con su importe y su cargo.
   *  · `authorized`      → retenido, pendiente de capturar.
   *  · `requires_action` → **no ha pasado nada todavía**: se guarda la
   *                        referencia y la fila sigue en `pending`. Quien llama
   *                        recibe el `clientSecret` y decide.
   *  · `failed`/`voided` → fallido, con lo que dijo el procesador.
   */
  private async anotarElResultado(tx: Transaction, a: Authorization): Promise<Transaction> {
    switch (a.status) {
      case 'captured':
        return this.transacciones.marcarCapturada(tx.id, a.providerRef, a.amount, a.chargeRef);
      case 'authorized':
        return this.transacciones.marcarAutorizada(tx.id, a.providerRef);
      case 'requires_action':
        this.log.log(`${tx.idempotencyKey}: el cobro ${a.providerRef} necesita autenticación; no está cobrado.`);
        return this.transacciones.guardarReferencia(tx.id, a.providerRef);
      case 'failed':
      case 'voided':
      default:
        this.log.warn(`${tx.idempotencyKey}: el cobro ${a.providerRef} quedó en '${a.status}'.`);
        return this.transacciones.marcarFallida(tx.id, `provider_status_${a.status}`);
    }
  }

  /**
   * Cobra en persona, con el teléfono del chofer como lector.
   *
   * Es el mismo caso de uso que `autorizar` —primero el libro, después el
   * procesador— con dos diferencias que vienen del contrato:
   *
   *  · Exige la capacidad `tapToPay`, así que el registro elige un procesador
   *    que sepa hacerlo aunque el de por defecto no sepa.
   *  · El cobro lo **confirma el SDK del teléfono**, no nosotros: lo que se
   *    devuelve es el secreto con el que ese SDK lo remata. Hasta que remate, el
   *    cobro no ha ocurrido, y el libro lo dice.
   *
   * Hoy el cobro presencial no pasa por ningún libro: se crea en Stripe y se
   * entera el webhook. Que pase por aquí es justo lo que hace que un cobro en
   * persona se pueda conciliar como cualquier otro.
   */
  async cobrarEnPersona(
    p: PeticionDeCobro & { terminalRef?: string; proveedor?: ProviderName },
  ): Promise<{
    transaccion: Transaction;
    autorizacion: Authorization | null;
    /** Sólo cuando cobra el SDK del teléfono: lo que éste necesita para crear el pago. */
    dispositivo?: { referenceId: string; paymentAttemptId: string };
  }> {
    // `proveedor` es el que pide quien llama: una app ya publicada espera el cobro
    // presencial de Stripe aunque el procesador por defecto sea Square.
    const provider = this.registry.paraCobroNuevo(['tapToPay'], p.proveedor);

    // Dos formas de cobrar en persona. Con Stripe el servidor crea el cobro y el
    // teléfono lo remata (`presentCharge`). Con Square el teléfono crea el pago por
    // sí mismo y el servidor lo adopta después (`adoptPayment`).
    const delDispositivo = !provider.presentCharge && Boolean(provider.adoptPayment);
    if (!provider.presentCharge && !delDispositivo) {
      throw new EstadoInesperadoError(
        `'${provider.name}' dice saber cobrar en persona pero no implementa presentCharge ni adoptPayment.`,
      );
    }

    const { transaccion, yaExistia } = await this.transacciones.crearSiNoExiste({
      idempotencyKey: p.idempotencyKey,
      provider: provider.name,
      kind: p.kind,
      rideId: p.rideId ?? null,
      payerId: p.payerId ?? null,
      amountCents: p.amountCents,
      taxCents: p.taxCents ?? 0,
      currency: p.currency,
    });

    if (delDispositivo) {
      // No se llama al procesador: el cobro lo crea el teléfono. Aquí queda la
      // intención apuntada (`pending`, sin referencia) y se devuelve lo que el SDK
      // necesita. Un reintento devuelve la misma fila, así que dar dos veces al
      // botón no apunta dos cobros.
      return {
        transaccion,
        autorizacion: null,
        dispositivo: {
          // La referencia es lo que se comprueba al adoptar: el pago tiene que
          // venir atado a ESTE viaje.
          referenceId: (p.rideId ?? transaccion.id).slice(0, 40),
          paymentAttemptId: provider.deviceAttemptKey
            ? provider.deviceAttemptKey(p.idempotencyKey)
            : p.idempotencyKey,
        },
      };
    }
    const presentCharge = provider.presentCharge!.bind(provider);

    // Un reintento del chofer —le dio dos veces al botón, se le fue la red—
    // devuelve el mismo cobro, no uno nuevo.
    if (yaExistia && transaccion.providerRef) {
      this.log.log(`Reintento presencial de ${p.idempotencyKey}: ya existe ${transaccion.providerRef}.`);
      let autorizacion: Authorization | null = null;
      try {
        autorizacion = await this.registry
          .paraCobroExistente(transaccion.provider)
          .getAuthorization(transaccion.providerRef);
      } catch (e) {
        this.log.warn(`No se pudo releer ${transaccion.providerRef}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return { transaccion, autorizacion };
    }

    try {
      const autorizacion = await presentCharge({
        idempotencyKey: p.idempotencyKey,
        kind: p.kind,
        amount: p.amountCents,
        currency: p.currency,
        hold: p.hold,
        taxAmount: p.taxCents,
        description: p.description,
        reference: { rideId: p.rideId, payerId: p.payerId },
        metadata: p.metadata,
        ...(p.terminalRef ? { terminalRef: p.terminalRef } : {}),
      });

      const actualizada = await this.anotarElResultado(transaccion, autorizacion);
      return { transaccion: actualizada, autorizacion };
    } catch (e) {
      await this.transacciones.marcarFallida(transaccion.id, this.codigoDeError(e));
      throw e;
    }
  }

  /**
   * El token con el que el teléfono del chofer se vuelve lector.
   *
   * No se guarda ni se reutiliza: dura minutos y se pide uno por sesión.
   */
  async sesionDeTerminal(preferido?: ProviderName): Promise<TerminalSession> {
    const provider = this.registry.paraCobroNuevo(['tapToPay'], preferido);
    if (!provider.terminalSession) {
      throw new EstadoInesperadoError(
        `'${provider.name}' dice saber cobrar en persona pero no implementa terminalSession.`,
      );
    }
    return provider.terminalSession();
  }

  /**
   * Da por cobrado en el libro un pago que el SDK del teléfono ya hizo.
   *
   * Es la segunda mitad del cobro con Square: el teléfono creó el pago, y aquí se
   * lee del procesador y se comprueba contra lo que ESTE servicio esperaba —el
   * importe, la moneda y el viaje salen de la fila, no de lo que diga el
   * teléfono— antes de marcarlo capturado.
   *
   * Es seguro repetirlo: adoptar el mismo pago dos veces devuelve el cobro ya
   * capturado sin volver a preguntar. Lo que no se puede es colgar un pago
   * distinto de un cobro ya capturado, ni el mismo pago de dos cobros.
   */
  async adoptarCobroPresencial(clave: string, providerRef: string): Promise<Transaction> {
    const tx = await this.transacciones.porClaveDeIdempotencia(clave);
    if (!tx) throw new TransaccionNoEncontradaError(clave);

    if (tx.status === 'captured') {
      if (tx.providerRef === providerRef) return tx;
      throw new EstadoInesperadoError(
        `${clave} ya está cobrado con ${tx.providerRef ?? 'otro pago'}: no se puede adoptar ${providerRef}.`,
      );
    }
    if (tx.status !== 'pending') {
      throw new EstadoInesperadoError(`${clave} está '${tx.status}': no se puede adoptar un pago sobre él.`);
    }

    const provider = this.registry.paraCobroExistente(tx.provider);
    if (!provider.adoptPayment) {
      throw new EstadoInesperadoError(`'${provider.name}' no implementa adoptPayment: sus cobros presenciales los crea el servidor.`);
    }

    // El mismo pago no puede sostener dos cobros. El índice único de la base lo
    // impide también, pero preguntar antes da un error que se entiende y evita
    // gastar una llamada al procesador.
    const otra = await this.transacciones.porReferenciaDelProveedor(tx.provider, providerRef);
    if (otra && otra.id !== tx.id) {
      throw new EstadoInesperadoError(
        `El pago ${providerRef} ya está adoptado por ${otra.idempotencyKey}: no puede sostener también ${clave}.`,
      );
    }

    try {
      const a = await provider.adoptPayment({
        providerRef,
        expected: {
          amount: tx.amountCents,
          currency: tx.currency,
          ...(tx.rideId ? { reference: tx.rideId } : {}),
        },
      });
      return await this.transacciones.marcarCapturada(tx.id, a.providerRef, a.amount, a.chargeRef);
    } catch (e) {
      if (e instanceof PagoNoAdoptableError) {
        // El teléfono cobró algo que no es lo esperado. El cobro se queda `pending`
        // —no se da por cobrado— y esto se registra alto: hay dinero en el
        // procesador que no cuadra con el libro y una persona tiene que mirarlo.
        this.log.error(`${clave}: el pago ${providerRef} NO se adopta (${e.motivo}): ${e.message}`);
      }
      throw e;
    }
  }

  /**
   * Cobra lo retenido, entero o en parte.
   *
   * Capturar algo ya capturado no es un error: es un reintento, y devolver lo
   * que hay evita que quien llama tenga que distinguir ambos casos.
   */
  async capturar(idempotencyKey: string, amountCents?: Cents): Promise<Transaction> {
    const tx = await this.exigirPorClave(idempotencyKey);

    if (tx.status === 'captured') {
      this.log.log(`La transacción ${tx.id} ya estaba capturada; no se vuelve a cobrar.`);
      return tx;
    }
    if (tx.status !== 'authorized' || !tx.providerRef) {
      throw new EstadoInesperadoError(
        `No se puede capturar una transacción en estado '${tx.status}' (${tx.id}).`,
      );
    }

    const provider = this.registry.paraCobroExistente(tx.provider);

    // Capturar nunca puede pasar del importe autorizado. Cuando el total final
    // es mayor —el cargo por espera del viaje, que sólo se sabe al terminar—
    // hay que subir primero la autorización. Si el procesador no sabe o el
    // banco se niega, se captura lo que había: cobrar de menos es un problema,
    // pero reventar la captura deja el viaje sin cobrar, que es peor.
    let autorizado = tx.amountCents;
    if (amountCents !== undefined && amountCents > autorizado) {
      autorizado = await this.subirAutorizacion(provider, tx, amountCents);
    }

    const captura: Capture = await provider.capture({
      idempotencyKey: `${idempotencyKey}_capture`,
      providerRef: tx.providerRef,
      amount: amountCents === undefined ? undefined : Math.min(amountCents, autorizado),
    });

    return this.transacciones.marcarCapturada(tx.id, captura.providerRef, captura.captured, captura.chargeRef);
  }

  /** Devuelve el importe autorizado que ha quedado, suba o no. */
  private async subirAutorizacion(
    provider: PaymentProvider,
    tx: Transaction,
    nuevoTotal: Cents,
  ): Promise<Cents> {
    if (!provider.capabilities.increaseAuthorization || !provider.increaseAuthorization) {
      this.log.warn(
        `'${provider.name}' no sabe subir una autorización: ${tx.id} se captura por ${tx.amountCents} y no por ${nuevoTotal}.`,
      );
      return tx.amountCents;
    }
    try {
      const subida = await provider.increaseAuthorization({
        // El importe entra en la clave: subir a 12000 y subir a 13000 son dos
        // operaciones distintas, y reusar la clave con otro importe lo rechaza
        // el propio procesador.
        idempotencyKey: `${tx.idempotencyKey}_increase_${nuevoTotal}`,
        providerRef: tx.providerRef!,
        amount: nuevoTotal,
      });
      this.log.log(`Autorización ${tx.providerRef} subida de ${tx.amountCents} a ${subida.amount}.`);
      return subida.amount;
    } catch (e) {
      this.log.error(
        `No se pudo subir la autorización ${tx.providerRef} a ${nuevoTotal}; se captura ${tx.amountCents}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return tx.amountCents;
    }
  }

  /** Suelta una retención que nunca llegó a cobrarse. */
  async anular(idempotencyKey: string): Promise<Transaction> {
    const tx = await this.exigirPorClave(idempotencyKey);

    if (tx.status === 'voided') return tx;
    if (tx.status !== 'authorized' || !tx.providerRef) {
      throw new EstadoInesperadoError(
        `No se puede anular una transacción en estado '${tx.status}' (${tx.id}).`,
      );
    }

    const provider = this.registry.paraCobroExistente(tx.provider);
    await provider.voidAuthorization({
      idempotencyKey: `${idempotencyKey}_void`,
      providerRef: tx.providerRef,
    });

    return this.transacciones.marcarAnulada(tx.id);
  }

  /** Devuelve dinero ya cobrado, entero o en parte. */
  async reembolsar(
    idempotencyKey: string,
    opciones: { amountCents?: Cents; reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer' } = {},
  ): Promise<{ transaccion: Transaction; reembolso: Refund }> {
    const tx = await this.exigirPorClave(idempotencyKey);

    if (tx.status !== 'captured' || !tx.providerRef) {
      throw new EstadoInesperadoError(
        `Sólo se puede reembolsar un cobro capturado; '${tx.status}' no lo es (${tx.id}).`,
      );
    }

    // Aquí es donde se nota la regla: aunque hoy el procesador por defecto sea
    // otro, este cobro vuelve al suyo. Un reembolso en la pasarela equivocada
    // no existe.
    const provider = this.registry.paraCobroExistente(tx.provider);
    const reembolso = await provider.refund({
      idempotencyKey: `${idempotencyKey}_refund`,
      providerRef: tx.providerRef,
      amount: opciones.amountCents,
      reason: opciones.reason,
    });

    // El asiento se apunta aquí y no se espera al webhook: si los webhooks no
    // estuvieran configurados, el libro no se enteraría nunca de una
    // devolución que sí ocurrió. Y cuando el aviso llegue —que llegará— no lo
    // apuntará dos veces, porque la clave sale de la misma referencia.
    await this.asientos.asentar(
      asientosDeReembolso({
        transactionId: tx.id,
        refundRef: reembolso.providerRef,
        devueltoCents: reembolso.refunded,
        currency: tx.currency,
        provider: tx.provider,
        memo: opciones.reason ? `reembolso (${opciones.reason})` : undefined,
      }),
    );

    const total = opciones.amountCents === undefined || opciones.amountCents >= tx.amountCents;
    const transaccion = total ? await this.transacciones.marcarReembolsada(tx.id) : tx;

    return { transaccion, reembolso };
  }

  /** La transacción con esa clave, o `null`. Es lo que consulta `urbont-api`. */
  async porClave(clave: string): Promise<Transaction | null> {
    return this.transacciones.porClaveDeIdempotencia(clave);
  }

  private async exigirPorClave(clave: string): Promise<Transaction> {
    const tx = await this.transacciones.porClaveDeIdempotencia(clave);
    if (!tx) throw new TransaccionNoEncontradaError(clave);
    return tx;
  }

  private codigoDeError(e: unknown): string {
    if (e && typeof e === 'object' && 'code' in e && typeof e.code === 'string') return e.code;
    if (e instanceof Error) return e.message.slice(0, 120);
    return 'error_desconocido';
  }
}
