/**
 * El libro de cobros sobre Postgres.
 *
 * La idempotencia no se implementa comprobando antes de insertar —entre la
 * comprobación y la inserción caben dos peticiones y dos cobros—, sino dejando
 * que la restricción única de la base decida: `ON CONFLICT DO NOTHING`, y si no
 * salió fila es que ya existía.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { POOL } from '../db/pool';
import type { Cents, ProviderName } from '../providers/provider.port';
import type {
  NuevaTransaccion,
  ResultadoDeCreacion,
  Transaction,
  TransactionsRepository,
} from './transactions.repository';

/** Una fila de `payments.transactions` tal como la devuelve Postgres. */
interface Fila {
  id: string;
  idempotency_key: string;
  provider: string;
  provider_ref: string | null;
  charge_ref: string | null;
  kind: string;
  ride_id: string | null;
  payer_id: string | null;
  amount_cents: number;
  tax_cents: number;
  currency: string;
  status: string;
  authorized_at: Date | null;
  captured_at: Date | null;
  failed_at: Date | null;
  failure_code: string | null;
  created_at: Date;
}

const COLUMNAS = `
  id, idempotency_key, provider, provider_ref, charge_ref, kind, ride_id, payer_id,
  amount_cents, tax_cents, currency, status,
  authorized_at, captured_at, failed_at, failure_code, created_at
`;

function aTransaccion(f: Fila): Transaction {
  return {
    id: f.id,
    idempotencyKey: f.idempotency_key,
    provider: f.provider as Transaction['provider'],
    providerRef: f.provider_ref,
    chargeRef: f.charge_ref,
    kind: f.kind as Transaction['kind'],
    rideId: f.ride_id,
    payerId: f.payer_id,
    amountCents: f.amount_cents,
    taxCents: f.tax_cents,
    currency: f.currency as Transaction['currency'],
    status: f.status as Transaction['status'],
    authorizedAt: f.authorized_at,
    capturedAt: f.captured_at,
    failedAt: f.failed_at,
    failureCode: f.failure_code,
    createdAt: f.created_at,
  };
}

@Injectable()
export class PgTransactionsRepository implements TransactionsRepository {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  async crearSiNoExiste(nueva: NuevaTransaccion): Promise<ResultadoDeCreacion> {
    const insercion = await this.pool.query<Fila>(
      `INSERT INTO payments.transactions
         (idempotency_key, provider, kind, ride_id, payer_id, amount_cents, tax_cents, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${COLUMNAS}`,
      [
        nueva.idempotencyKey,
        nueva.provider,
        nueva.kind,
        nueva.rideId ?? null,
        nueva.payerId ?? null,
        nueva.amountCents,
        nueva.taxCents ?? 0,
        nueva.currency,
      ],
    );

    if (insercion.rows[0]) {
      return { transaccion: aTransaccion(insercion.rows[0]), yaExistia: false };
    }

    // No salió fila: la clave ya estaba. Esto es un reintento.
    const existente = await this.porClaveDeIdempotencia(nueva.idempotencyKey);
    if (!existente) {
      throw new Error(
        `La clave ${nueva.idempotencyKey} dio conflicto pero no se encuentra la fila; ¿se borró a mano?`,
      );
    }
    return { transaccion: existente, yaExistia: true };
  }

  async porId(id: string): Promise<Transaction | null> {
    const { rows } = await this.pool.query<Fila>(
      `SELECT ${COLUMNAS} FROM payments.transactions WHERE id = $1`,
      [id],
    );
    return rows[0] ? aTransaccion(rows[0]) : null;
  }

  async porClaveDeIdempotencia(clave: string): Promise<Transaction | null> {
    const { rows } = await this.pool.query<Fila>(
      `SELECT ${COLUMNAS} FROM payments.transactions WHERE idempotency_key = $1`,
      [clave],
    );
    return rows[0] ? aTransaccion(rows[0]) : null;
  }

  async porReferenciaDelProveedor(provider: ProviderName, providerRef: string): Promise<Transaction | null> {
    const { rows } = await this.pool.query<Fila>(
      `SELECT ${COLUMNAS} FROM payments.transactions WHERE provider = $1 AND provider_ref = $2`,
      [provider, providerRef],
    );
    return rows[0] ? aTransaccion(rows[0]) : null;
  }

  async capturadasEntre(
    provider: ProviderName,
    desde: Date,
    hasta: Date,
    limite: number,
  ): Promise<Array<{ chargeKey: string; chargeRef: string | null; providerRef: string | null; netoCents: Cents }>> {
    const { rows } = await this.pool.query<{
      chargeKey: string; chargeRef: string | null; providerRef: string | null; neto: string;
    }>(
      `SELECT t.idempotency_key AS "chargeKey",
              t.charge_ref      AS "chargeRef",
              t.provider_ref    AS "providerRef",
              (t.amount_cents + COALESCE((
                 SELECT SUM(e.amount_cents)
                   FROM payments.ledger_entries e
                  WHERE e.transaction_id = t.id
                    AND e.entry_type = 'refund'
                    AND e.account = 'clearing'
               ), 0))::bigint AS neto
         FROM payments.transactions t
        WHERE t.provider = $1
          AND t.status IN ('captured','refunded')
          AND t.captured_at >= $2 AND t.captured_at <= $3
        ORDER BY t.captured_at ASC
        LIMIT $4`,
      [provider, desde, hasta, limite],
    );
    return rows.map((r) => ({
      chargeKey: r.chargeKey,
      chargeRef: r.chargeRef,
      providerRef: r.providerRef,
      netoCents: Number(r.neto),
    }));
  }

  async marcarAutorizada(id: string, providerRef: string): Promise<Transaction> {
    return this.actualizar(
      `UPDATE payments.transactions
          SET status='authorized', provider_ref=$2, authorized_at=NOW(), updated_at=NOW()
        WHERE id=$1 RETURNING ${COLUMNAS}`,
      [id, providerRef],
    );
  }

  async guardarReferencia(id: string, providerRef: string): Promise<Transaction> {
    return this.actualizar(
      `UPDATE payments.transactions
          SET provider_ref=$2, updated_at=NOW()
        WHERE id=$1 RETURNING ${COLUMNAS}`,
      [id, providerRef],
    );
  }

  async marcarCapturada(
    id: string,
    providerRef: string,
    capturado: Cents,
    chargeRef?: string | null,
  ): Promise<Transaction> {
    // El importe capturado puede ser menor que el autorizado (una cancelación
    // con penalización), y es el que manda para repartir.
    //
    // `charge_ref` sólo se escribe si viene: un COALESCE y no una asignación,
    // porque un reintento que no lo traiga no debe borrar el que ya había.
    return this.actualizar(
      `UPDATE payments.transactions
          SET status='captured', provider_ref=$2, amount_cents=$3,
              charge_ref=COALESCE($4, charge_ref), captured_at=NOW(), updated_at=NOW()
        WHERE id=$1 RETURNING ${COLUMNAS}`,
      [id, providerRef, capturado, chargeRef ?? null],
    );
  }

  async marcarFallida(id: string, codigo: string): Promise<Transaction> {
    return this.actualizar(
      `UPDATE payments.transactions
          SET status='failed', failure_code=$2, failed_at=NOW(), updated_at=NOW()
        WHERE id=$1 RETURNING ${COLUMNAS}`,
      [id, codigo],
    );
  }

  async marcarAnulada(id: string): Promise<Transaction> {
    return this.actualizar(
      `UPDATE payments.transactions SET status='voided', updated_at=NOW()
        WHERE id=$1 RETURNING ${COLUMNAS}`,
      [id],
    );
  }

  async marcarReembolsada(id: string): Promise<Transaction> {
    return this.actualizar(
      `UPDATE payments.transactions SET status='refunded', updated_at=NOW()
        WHERE id=$1 RETURNING ${COLUMNAS}`,
      [id],
    );
  }

  private async actualizar(sql: string, params: unknown[]): Promise<Transaction> {
    const { rows } = await this.pool.query<Fila>(sql, params);
    if (!rows[0]) throw new Error(`No existe la transacción ${String(params[0])}`);
    return aTransaccion(rows[0]);
  }
}
