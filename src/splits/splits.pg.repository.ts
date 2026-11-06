import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { POOL } from '../db/pool';
import type { ProviderName } from '../providers/provider.port';
import type { NuevaParte, Split, SplitsRepository } from './splits.repository';

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
}

const COLUMNAS = `
  id, transaction_id, beneficiary_type, beneficiary_id, amount_cents, deduction_cents,
  rate, status, provider, provider_transfer_ref, failure_code, memo, paid_at, created_at
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
      );
      return `($1, $${i + 1}, $${i + 2}::uuid, $${i + 3}::int, $${i + 4}::int, $${i + 5}::numeric, $${i + 6})`;
    });

    await this.pool.query(
      `INSERT INTO payments.splits
         (transaction_id, beneficiary_type, beneficiary_id, amount_cents, deduction_cents, rate, memo)
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

  private async actualizar(sql: string, params: unknown[]): Promise<Split> {
    const { rows } = await this.pool.query<Fila>(sql, params);
    if (!rows[0]) throw new Error(`No existe la parte del reparto ${String(params[0])}`);
    return aSplit(rows[0]);
  }
}
