/**
 * El libro de cobros: qué se intentó, con qué procesador y cómo acabó.
 *
 * Es un puerto y no una clase concreta para que los casos de uso se puedan
 * probar sin base de datos. La implementación real está en
 * `transactions.pg.repository.ts`.
 *
 * La regla que lo sostiene todo: **una clave de idempotencia, una fila**. Quien
 * llama deriva la clave del viaje y de la operación (`ride_abc_authorize`), de
 * modo que un reintento —el móvil que pierde la respuesta y reenvía, la API que
 * reintenta un 502— cae sobre la misma fila en vez de crear un segundo cobro.
 */

import type { Cents, ChargeKind, Currency, ProviderName } from '../providers/provider.port';

export type TransactionStatus =
  | 'pending'
  | 'authorized'
  | 'captured'
  | 'failed'
  | 'refunded'
  | 'voided';

export interface Transaction {
  id: string;
  idempotencyKey: string;
  provider: ProviderName;
  providerRef: string | null;
  kind: ChargeKind;
  rideId: string | null;
  payerId: string | null;
  amountCents: Cents;
  taxCents: Cents;
  currency: Currency;
  status: TransactionStatus;
  authorizedAt: Date | null;
  capturedAt: Date | null;
  failedAt: Date | null;
  failureCode: string | null;
  createdAt: Date;
}

export interface NuevaTransaccion {
  idempotencyKey: string;
  provider: ProviderName;
  kind: ChargeKind;
  rideId?: string | null;
  payerId?: string | null;
  amountCents: Cents;
  taxCents?: Cents;
  currency: Currency;
}

/** Lo que devuelve `crearSiNoExiste`: la fila y si la acabamos de crear. */
export interface ResultadoDeCreacion {
  transaccion: Transaction;
  yaExistia: boolean;
}

export interface TransactionsRepository {
  /**
   * Crea la transacción, o devuelve la que ya hubiera con esa clave.
   *
   * `yaExistia: true` es la señal de que esto es un reintento y de que **no hay
   * que volver a llamar al procesador**.
   */
  crearSiNoExiste(nueva: NuevaTransaccion): Promise<ResultadoDeCreacion>;

  porId(id: string): Promise<Transaction | null>;
  porClaveDeIdempotencia(clave: string): Promise<Transaction | null>;
  porReferenciaDelProveedor(provider: ProviderName, providerRef: string): Promise<Transaction | null>;

  /** Guarda la referencia del procesador en cuanto se conoce. */
  marcarAutorizada(id: string, providerRef: string): Promise<Transaction>;
  marcarCapturada(id: string, providerRef: string, capturado: Cents): Promise<Transaction>;
  marcarFallida(id: string, codigo: string): Promise<Transaction>;
  marcarAnulada(id: string): Promise<Transaction>;
  marcarReembolsada(id: string): Promise<Transaction>;
}

export const TRANSACTIONS_REPOSITORY = Symbol('TRANSACTIONS_REPOSITORY');
