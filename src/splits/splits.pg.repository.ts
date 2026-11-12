import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { POOL } from '../db/pool';
import type { ProviderName } from '../providers/provider.port';
import type { NuevaParte, SaldoPorPagar, Split, SplitsRepository } from './splits.repository';

interface Fila {
  id: string;
  transaction_id: string;
  beneficiary_type: string;
  beneficiary_id: string | null;
  amount_cents: number;
  deduction_cents: number;
  rate: string | null;
  status: string;
  provider: string | null;
  provider_transfer_ref: string | null;
  failure_code: string | null;
  memo: string | null;
  paid_at: Date | null;
  created_at: Date;
  settlement_mode: string;
  payout_id: string | null;
}

const COLUMNAS = `
  id, transaction_id, beneficiary_type, beneficiary_id, amount_cents, deduction_cents,
  rate, status, provider, provider_transfer_ref, failure_code, memo, paid_at, created_at,
  settlement_mode, payout_id
`;

function aSplit(f: Fila): Split {
  return {
    id: f.id,
    transactionId: f.transaction_id,
    beneficiaryType: f.beneficiary_type as Split['beneficiaryType'],
    beneficiaryId: f.beneficiary_id,
    amountCents: f.amount_cents,
    deductionCents: f.deduction_cents,
    // NUMERIC vuelve como cadena de pg: convertirlo aquí evita que un '0.1500'
    // acabe comparándose con 0.15 en otro sitio.
    rate: f.rate === null ? null : Number(f.rate),
    status: f.status as Split['status'],
    provider: f.provider as ProviderName | null,
    providerTransferRef: f.provider_transfer_ref,
    failureCode: f.failure_code,
    memo: f.memo,
    paidAt: f.paid_at,
    createdAt: f.created_at,
    settlementMode: f.settlement_mode as Split['settlementMode'],
    payoutId: f.payout_id,
  };
}

@Injectable()
export class PgSplitsRepository implements SplitsRepository {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  async crearSiNoExisten(transactionId: string, partes: NuevaParte[]): Promise<Split[]> {
    if (partes.length === 0) return this.porTransaccion(transactionId);

    // Una sola sentencia para todas las partes: insertándolas de una en una, un
    // corte en medio dejaría al chofer apuntado y al valet no, y el siguiente
    // intento repartiría sobre un reparto a medias.
    const valores: unknown[] = [transactionId];
    const tuplas = partes.map((p) => {
      const i = valores.length;
      valores.push(
        p.beneficiaryType,
        p.beneficiaryId ?? null,
        p.amountCents,
        p.deductionCents ?? 0,
        p.rate ?? null,
        p.memo ?? null,
        p.settlementMode ?? 'provider',
      );
      return `($1, $${i + 1}, $${i + 2}::uuid, $${i + 3}::int, $${i + 4}::int, $${i + 5}::numeric, $${i + 6}, $${i + 7})`;
    });

    await this.pool.query(
      `INSERT INTO payments.splits
         (transaction_id, beneficiary_type, beneficiary_id, amount_cents, deduction_cents, rate, memo,
          settlement_mode)
       VALUES ${tuplas.join(', ')}
       ON CONFLICT DO NOTHING`,
      valores,
    );

    return this.porTransaccion(transactionId);
  }

  async porTransaccion(transactionId: string): Promise<Split[]> {
    const { rows } = await this.pool.query<Fila>(
      `SELECT ${COLUMNAS} FROM payments.splits
        WHERE transaction_id = $1
        ORDER BY beneficiary_type`,
      [transactionId],
    );
    return rows.map(aSplit);
  }

  async marcarPagada(id: string, provider: ProviderName, transferRef: string | null): Promise<Split> {
    return this.actualizar(
      `UPDATE payments.splits
          SET status='paid', provider=$2, provider_transfer_ref=$3,
              failure_code=NULL, paid_at=NOW(), updated_at=NOW()
        WHERE id=$1 RETURNING ${COLUMNAS}`,
      [id, provider, transferRef],
    );
  }

  async marcarFallida(id: string, codigo: string): Promise<Split> {
    return this.actualizar(
      `UPDATE payments.splits
          SET status='failed', failure_code=$2, updated_at=NOW()
        WHERE id=$1 RETURNING ${COLUMNAS}`,
      [id, codigo.slice(0, 200)],
    );
  }

  // ── Liquidación manual ──────────────────────────────────────────────────

  async saldos(): Promise<SaldoPorPagar[]> {
    const { rows } = await this.pool.query<{
      payee_type: string; payee_id: string; partes_pendientes: string;
      total_cents: string; desde: Date; hasta: Date;
    }>(`SELECT payee_type, payee_id, partes_pendientes, total_cents, desde, hasta
          FROM payments.saldos_por_pagar
         WHERE payee_id IS NOT NULL
         ORDER BY total_cents DESC`);

    return rows.map((f) => ({
      payeeType: f.payee_type as SaldoPorPagar['payeeType'],
      payeeId: f.payee_id,
      // COUNT y SUM vuelven como cadena en pg: un BIGINT no cabe en un number
      // sin pérdida, y aunque estos importes sí quepan, dejarlos como cadena
      // haría que se sumaran concatenando en cuanto alguien los use.
      partesPendientes: Number(f.partes_pendientes),
      totalCents: Number(f.total_cents),
      desde: f.desde,
      hasta: f.hasta,
    }));
  }

  async pendientesDe(payeeType: string, payeeId: string): Promise<Split[]> {
    const { rows } = await this.pool.query<Fila>(
      `SELECT ${COLUMNAS} FROM payments.splits
        WHERE beneficiary_type = $1 AND beneficiary_id = $2::uuid
          AND status IN ('pending','failed') AND amount_cents > 0
        ORDER BY created_at`,
      [payeeType, payeeId],
    );
    return rows.map(aSplit);
  }

  async marcarPagadasAMano(ids: string[], payoutId: string): Promise<Split[]> {
    if (ids.length === 0) return [];

    // El `status IN ('pending','failed')` del WHERE no es decoración: es lo que
    // hace que dos personas pagando a la vez no marquen la misma parte dos
    // veces. La que llegue segunda no actualiza nada y no vuelve aquí, y quien
    // llama lo nota porque el importe no cuadra.
    const { rows } = await this.pool.query<Fila>(
      `UPDATE payments.splits
          SET status='paid', payout_id=$2::uuid, paid_at=NOW(), updated_at=NOW(),
              failure_code=NULL
        WHERE id = ANY($1::uuid[])
          AND status IN ('pending','failed')
        RETURNING ${COLUMNAS}`,
      [ids, payoutId],
    );
    return rows.map(aSplit);
  }

  private async actualizar(sql: string, params: unknown[]): Promise<Split> {
    const { rows } = await this.pool.query<Fila>(sql, params);
    if (!rows[0]) throw new Error(`No existe la parte del reparto ${String(params[0])}`);
    return aSplit(rows[0]);
  }
}
