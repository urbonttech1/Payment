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
import type {
  Authorization,
  Capture,
  Cents,
  ChargeKind,
  Currency,
  PaymentProvider,
  Refund,
} from '../providers/provider.port';

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
  ) {}

  /**
   * Autoriza (o cobra) un importe.
   *
   * El importe llega ya resuelto por quien llama; este servicio no lo discute,
   * pero tampoco lo acepta de un cliente: `urbont-api` lo calcula contra el
   * viaje antes de pedirlo.
   */
  async autorizar(p: PeticionDeCobro): Promise<{ transaccion: Transaction; autorizacion: Authorization | null }> {
    const provider = this.registry.paraCobroNuevo(p.hold ? ['manualCapture'] : []);

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

    try {
      const autorizacion = await provider.authorize({
        idempotencyKey: p.idempotencyKey,
        kind: p.kind,
        amount: p.amountCents,
        currency: p.currency,
        hold: p.hold,
        taxAmount: p.taxCents,
        customerRef: p.customerRef,
        cardRef: p.cardRef,
        reference: { rideId: p.rideId, payerId: p.payerId },
        metadata: p.metadata,
      });

      const actualizada =
        autorizacion.status === 'captured'
          ? await this.transacciones.marcarCapturada(transaccion.id, autorizacion.providerRef, autorizacion.amount, autorizacion.chargeRef)
          : await this.transacciones.marcarAutorizada(transaccion.id, autorizacion.providerRef);

      return { transaccion: actualizada, autorizacion };
    } catch (e) {
      const codigo = this.codigoDeError(e);
      await this.transacciones.marcarFallida(transaccion.id, codigo);
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
