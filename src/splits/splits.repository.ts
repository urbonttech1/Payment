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
}

export interface NuevaParte {
  beneficiaryType: TipoDeBeneficiario;
  beneficiaryId?: string | null;
  amountCents: Cents;
  deductionCents?: Cents;
  rate?: number | null;
  memo?: string | null;
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
}

export const SPLITS_REPOSITORY = Symbol('SPLITS_REPOSITORY');
