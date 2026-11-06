import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { POOL } from '../db/pool';
import type { Cents, Currency, ProviderName } from '../providers/provider.port';
import type { Asiento, EntriesRepository, NuevoAsiento } from './entries.repository';

interface Fila {
  id: string;
  entry_key: string;
  transaction_id: string;
  split_id: string | null;
  entry_type: string;
  account: string;
  amount_cents: string;
  currency: string;
  provider: string | null;
  provider_ref: string | null;
  memo: string | null;
  occurred_at: Date;
}

function aAsiento(f: Fila): Asiento {
  return {
    id: String(f.id),
    entryKey: f.entry_key,
    transactionId: f.transaction_id,
    splitId: f.split_id,
    entryType: f.entry_type as Asiento['entryType'],
    account: f.account as Asiento['account'],
    // BIGINT vuelve como cadena de pg para no perder precisión; en centavos de
    // un viaje cabe de sobra en un number.
    amountCents: Number(f.amount_cents),
    currency: f.currency as Currency,
    provider: f.provider as ProviderName | null,
    providerRef: f.provider_ref,
    memo: f.memo,
    occurredAt: f.occurred_at,
  };
}

@Injectable()
export class PgEntriesRepository implements EntriesRepository {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  async asentar(asientos: NuevoAsiento[]): Promise<number> {
    if (asientos.length === 0) return 0;

    const valores: unknown[] = [];
    const tuplas = asientos.map((a) => {
      const i = valores.length;
      valores.push(
        a.entryKey,
        a.transactionId,
        a.splitId ?? null,
        a.entryType,
        a.account,
        a.amountCents,
        a.currency ?? 'USD',
        a.provider ?? null,
        a.providerRef ?? null,
        a.memo ?? null,
      );
      return `($${i + 1}, $${i + 2}::uuid, $${i + 3}::uuid, $${i + 4}, $${i + 5}, $${i + 6}::bigint, $${i + 7}, $${i + 8}, $${i + 9}, $${i + 10})`;
    });

    const { rowCount } = await this.pool.query(
      `INSERT INTO payments.ledger_entries
         (entry_key, transaction_id, split_id, entry_type, account, amount_cents, currency, provider, provider_ref, memo)
       VALUES ${tuplas.join(', ')}
       ON CONFLICT (entry_key) WHERE entry_key IS NOT NULL DO NOTHING`,
      valores,
    );
    return rowCount ?? 0;
  }

  async porTransaccion(transactionId: string): Promise<Asiento[]> {
    const { rows } = await this.pool.query<Fila>(
      `SELECT id, entry_key, transaction_id, split_id, entry_type, account,
              amount_cents, currency, provider, provider_ref, memo, occurred_at
         FROM payments.ledger_entries
        WHERE transaction_id = $1
        ORDER BY id`,
      [transactionId],
    );
    return rows.map(aAsiento);
  }

  async saldos(transactionId: string): Promise<Record<string, Cents>> {
    const { rows } = await this.pool.query<{ account: string; saldo: string }>(
      `SELECT account, SUM(amount_cents)::bigint AS saldo
         FROM payments.ledger_entries
        WHERE transaction_id = $1
        GROUP BY account`,
      [transactionId],
    );
    return Object.fromEntries(rows.map((r) => [r.account, Number(r.saldo)]));
  }
}
