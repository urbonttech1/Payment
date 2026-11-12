/**
 * El reparto guardado: quién cobra cuánto de cada cobro, y si ya cobró.
 *
 * La regla que lo sostiene es la hermana de la del libro de cobros:
 * **un beneficiario cobra UNA vez de un cobro**. La hace cumplir el índice
 * único `(transaction_id, beneficiary_type, beneficiary_id)` de la base, no un
 * `if` en el código, porque entre comprobar y transferir caben dos peticiones y
 * dos transferencias. Es el antídoto del hallazgo 04 de la auditoría de
 * `urbont-api`, donde el chofer podía cobrar dos veces el mismo viaje.
 *
 * Y el orden también es el mismo que en el libro: **primero se apunta el
 * reparto, después se mueve el dinero.** Al revés, una transferencia que sale
 * bien y cuya fila no se llega a escribir es dinero pagado del que no queda
 * rastro, y el siguiente intento lo paga otra vez.
 */

import type { Cents, ProviderName } from '../providers/provider.port';
import type { TipoDeBeneficiario } from './reparto';

export type EstadoDeParte = 'pending' | 'sent' | 'paid' | 'failed' | 'reversed';

/**
 * Cómo se salda una parte del reparto.
 *
 *  · `provider` — la paga el procesador con una transferencia, como Stripe Connect.
 *  · `manual` — el procesador depositó todo en la cuenta de URBONT y la paga
 *    una persona por transferencia bancaria, una o dos veces por semana.
 *
 * No es una preferencia: Square no sabe pagarle a terceros, así que con Square
 * la única liquidación posible es la manual. Está en la fila y no sólo en la
 * configuración porque el modo con el que se apuntó una parte no puede cambiar
 * retroactivamente cuando alguien toca un ajuste.
 */
export type ModoDeLiquidacion = 'provider' | 'manual';

export interface Split {
  id: string;
  transactionId: string;
  beneficiaryType: TipoDeBeneficiario;
  beneficiaryId: string | null;
  amountCents: Cents;
  deductionCents: Cents;
  rate: number | null;
  status: EstadoDeParte;
  provider: ProviderName | null;
  providerTransferRef: string | null;
  failureCode: string | null;
  memo: string | null;
  paidAt: Date | null;
  createdAt: Date;
  settlementMode: ModoDeLiquidacion;
  /** El pago manual que saldó esta parte, si se saldó así. */
  payoutId: string | null;
}

export interface NuevaParte {
  beneficiaryType: TipoDeBeneficiario;
  beneficiaryId?: string | null;
  amountCents: Cents;
  deductionCents?: Cents;
  rate?: number | null;
  memo?: string | null;
  settlementMode?: ModoDeLiquidacion;
}

export interface SplitsRepository {
  /**
   * Apunta las partes que falten y devuelve TODAS las del cobro.
   *
   * Idempotente por construcción: lo que ya estaba no se toca ni se
   * sobreescribe, así que un segundo intento no puede cambiar un importe que ya
   * se pagó.
   */
  crearSiNoExisten(transactionId: string, partes: NuevaParte[]): Promise<Split[]>;

  porTransaccion(transactionId: string): Promise<Split[]>;

  marcarPagada(id: string, provider: ProviderName, transferRef: string | null): Promise<Split>;
  marcarFallida(id: string, codigo: string): Promise<Split>;

  // ── Liquidación manual ────────────────────────────────────────────────────

  /**
   * Lo que se le debe a cada persona, derivado de las partes sin pagar.
   *
   * Es una consulta y no una columna de saldo a propósito: un saldo guardado se
   * desincroniza del libro en cuanto algo falla a medias, y entonces hay dos
   * verdades sobre cuánto se le debe a alguien. Aquí la única verdad son las
   * partes.
   */
  saldos(): Promise<SaldoPorPagar[]>;

  /** Las partes sin pagar de una persona, que son las que salda un pago. */
  pendientesDe(payeeType: TipoDeBeneficiario, payeeId: string): Promise<Split[]>;

  /**
   * Marca como pagadas las partes que cubre un pago manual.
   *
   * Devuelve sólo las que de verdad cambiaron: si otra sesión pagó una de ellas
   * mientras tanto, esa no se toca y no se cuenta. Quien llama compara el
   * importe con lo que pidió pagar, porque pagar de más es tan malo como pagar
   * de menos.
   */
  marcarPagadasAMano(ids: string[], payoutId: string): Promise<Split[]>;
}

/** El acumulado de una persona: lo que hay que transferirle. */
export interface SaldoPorPagar {
  payeeType: TipoDeBeneficiario;
  payeeId: string;
  partesPendientes: number;
  totalCents: Cents;
  desde: Date;
  hasta: Date;
}

export const SPLITS_REPOSITORY = Symbol('SPLITS_REPOSITORY');
