import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { POOL } from '../db/pool';
import type {
  CuentaParaElPanel,
  EstadoDeCuenta,
  NuevaCuenta,
  NuevoPago,
  PagoRegistrado,
  Payout,
  PayoutAccountsRepository,
  PayoutsRepository,
} from './payouts.repository';
import { ImporteNoCuadraError } from './payouts.repository';

/**
 * La cuenta del libro que corresponde a cada beneficiario.
 *
 * Es la misma tabla que usa `splits.service.ts`. Está repetida y no importada
 * a propósito: importarla aquí ataría el módulo de pagos manuales al de
 * reparto, y lo único que comparten es este vocabulario contable.
 */
const CUENTA_DE: Record<string, string> = {
  driver: 'driver_payable',
  valet: 'valet_payable',
  platform: 'platform_revenue',
};

// ── Cuentas de cobro ────────────────────────────────────────────────────────

interface FilaCuenta {
  payee_id: string;
  payee_type: string;
  method: string;
  holder_name: string;
  bank_name: string | null;
  pista: string;
  status: string;
  status_reason: string | null;
  updated_by: string | null;
  updated_at: Date;
}

/**
 * Las columnas que se leen para el panel.
 *
 * `secreto_cifrado` NO está en la lista, y eso es deliberado: la consulta que
 * alimenta el panel no puede traerse los datos bancarios ni por accidente. Para
 * descifrarlos hay una ruta aparte (`secretoDe`), que se llama sólo en el
 * momento de pagar.
 */
const COLUMNAS_CUENTA = `
  payee_id, payee_type, method, holder_name, bank_name, pista,
  status, status_reason, updated_by, updated_at
`;

function aCuenta(f: FilaCuenta): CuentaParaElPanel {
  return {
    payeeId: f.payee_id,
    payeeType: f.payee_type as CuentaParaElPanel['payeeType'],
    method: f.method as CuentaParaElPanel['method'],
    holderName: f.holder_name,
    bankName: f.bank_name,
    pista: f.pista,
    status: f.status as EstadoDeCuenta,
    statusReason: f.status_reason,
    updatedBy: f.updated_by,
    updatedAt: f.updated_at,
  };
}

@Injectable()
export class PgPayoutAccountsRepository implements PayoutAccountsRepository {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  async listar(): Promise<CuentaParaElPanel[]> {
    const { rows } = await this.pool.query<FilaCuenta>(
      `SELECT ${COLUMNAS_CUENTA} FROM payments.payout_accounts ORDER BY holder_name`,
    );
    return rows.map(aCuenta);
  }

  async obtener(payeeId: string): Promise<CuentaParaElPanel | null> {
    const { rows } = await this.pool.query<FilaCuenta>(
      `SELECT ${COLUMNAS_CUENTA} FROM payments.payout_accounts WHERE payee_id = $1::uuid`,
      [payeeId],
    );
    return rows[0] ? aCuenta(rows[0]) : null;
  }

  async secretoDe(payeeId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ secreto_cifrado: string }>(
      'SELECT secreto_cifrado FROM payments.payout_accounts WHERE payee_id = $1::uuid',
      [payeeId],
    );
    return rows[0]?.secreto_cifrado ?? null;
  }

  async guardar(
    cuenta: NuevaCuenta,
    secretoCifrado: string,
    pista: string,
    quien: string,
  ): Promise<CuentaParaElPanel> {
    // Cambiar la cuenta la devuelve a `pending`: unos datos nuevos no heredan
    // la verificación de los viejos. Si no, cambiar el número bastaría para
    // cobrar en una cuenta que nadie comprobó.
    const { rows } = await this.pool.query<FilaCuenta>(
      `INSERT INTO payments.payout_accounts
         (payee_id, payee_type, method, holder_name, bank_name, secreto_cifrado, pista,
          status, status_reason, updated_by, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, 'pending', NULL, $8, NOW())
       ON CONFLICT (payee_id) DO UPDATE SET
         payee_type = EXCLUDED.payee_type,
         method = EXCLUDED.method,
         holder_name = EXCLUDED.holder_name,
         bank_name = EXCLUDED.bank_name,
         secreto_cifrado = EXCLUDED.secreto_cifrado,
         pista = EXCLUDED.pista,
         status = 'pending', status_reason = NULL,
         updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING ${COLUMNAS_CUENTA}`,
      [
        cuenta.payeeId,
        cuenta.payeeType,
        cuenta.method,
        cuenta.holderName.trim().slice(0, 200),
        cuenta.bankName?.trim().slice(0, 200) ?? null,
        secretoCifrado,
        pista,
        quien.slice(0, 200),
      ],
    );
    return aCuenta(rows[0]);
  }

  async cambiarEstado(
    payeeId: string,
    estado: EstadoDeCuenta,
    motivo: string | null,
    quien: string,
  ): Promise<CuentaParaElPanel> {
    const { rows } = await this.pool.query<FilaCuenta>(
      `UPDATE payments.payout_accounts
          SET status=$2, status_reason=$3, updated_by=$4, updated_at=NOW()
        WHERE payee_id=$1::uuid
        RETURNING ${COLUMNAS_CUENTA}`,
      [payeeId, estado, motivo?.slice(0, 500) ?? null, quien.slice(0, 200)],
    );
    if (!rows[0]) throw new Error(`No hay cuenta de cobro registrada para ${payeeId}`);
    return aCuenta(rows[0]);
  }
}

// ── Pagos hechos ────────────────────────────────────────────────────────────

interface FilaPago {
  id: string;
  payee_id: string;
  payee_type: string;
  amount_cents: string;
  currency: string;
  method: string;
  reference: string | null;
  notes: string | null;
  period_start: Date | null;
  period_end: Date | null;
  paid_at: Date;
  created_by: string;
}

const COLUMNAS_PAGO = `
  id, payee_id, payee_type, amount_cents, currency, method, reference, notes,
  period_start, period_end, paid_at, created_by
`;

function aPago(f: FilaPago): Payout {
  return {
    id: f.id,
    payeeId: f.payee_id,
    payeeType: f.payee_type as Payout['payeeType'],
    // BIGINT vuelve como cadena en pg. Convertirlo aquí evita que dos importes
    // se sumen concatenando más arriba.
    amountCents: Number(f.amount_cents),
    currency: f.currency,
    method: f.method as Payout['method'],
    reference: f.reference,
    notes: f.notes,
    periodStart: f.period_start,
    periodEnd: f.period_end,
    paidAt: f.paid_at,
    createdBy: f.created_by,
  };
}

@Injectable()
export class PgPayoutsRepository implements PayoutsRepository {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  /**
   * Registra el pago y salda sus partes, todo o nada.
   *
   * Esta es la única operación del servicio que escribe en tres tablas a la
   * vez —`payouts`, `splits` y `ledger_entries`—, y por eso vive aquí abajo con
   * un cliente propio en vez de repartirse entre tres repositorios: una
   * transacción no se puede coser desde arriba con tres pools distintos.
   */
  async pagarYSaldar(pago: NuevoPago, splitIds: string[]): Promise<PagoRegistrado> {
    const cliente = await this.pool.connect();
    try {
      await cliente.query('BEGIN');

      const { rows } = await cliente.query<FilaPago>(
        `INSERT INTO payments.payouts
           (payee_id, payee_type, amount_cents, currency, method, reference, notes,
            period_start, period_end, created_by)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${COLUMNAS_PAGO}`,
        [
          pago.payeeId,
          pago.payeeType,
          pago.amountCents,
          pago.currency,
          pago.method,
          pago.reference?.trim().slice(0, 200) || null,
          pago.notes?.trim().slice(0, 1000) || null,
          pago.periodStart ?? null,
          pago.periodEnd ?? null,
          pago.createdBy.slice(0, 200),
        ],
      );
      const guardado = aPago(rows[0]);

      // El `status IN ('pending','failed')` es lo que impide saldar dos veces
      // la misma parte: si otra sesión llegó antes, esa fila no se actualiza y
      // no vuelve aquí, y el importe deja de cuadrar unas líneas más abajo.
      const saldadas = await cliente.query<{
        id: string; amount_cents: number; transaction_id: string;
        beneficiary_type: string; currency: string;
      }>(
        `UPDATE payments.splits s
            SET status='paid', payout_id=$2::uuid, paid_at=NOW(),
                updated_at=NOW(), failure_code=NULL
          FROM payments.transactions t
          WHERE s.id = ANY($1::uuid[])
            AND s.transaction_id = t.id
            AND s.status IN ('pending','failed')
          RETURNING s.id, s.amount_cents, s.transaction_id,
                    s.beneficiary_type, t.currency`,
        [splitIds, guardado.id],
      );

      const total = saldadas.rows.reduce((a, f) => a + f.amount_cents, 0);
      if (total !== pago.amountCents) {
        await cliente.query('ROLLBACK');
        throw new ImporteNoCuadraError(pago.amountCents, total);
      }

      // El mismo asiento que deja un pago del procesador: se extingue la deuda
      // y el dinero sale de la cuenta de la plataforma. Que lo haya movido una
      // persona en vez de una API no cambia la contabilidad.
      for (const f of saldadas.rows) {
        const cuenta = CUENTA_DE[f.beneficiary_type] ?? 'clearing';
        await cliente.query(
          `INSERT INTO payments.ledger_entries
             (entry_key, transaction_id, split_id, entry_type, account, amount_cents,
              currency, provider, provider_ref, memo)
           VALUES ($1, $2::uuid, $3::uuid, 'payout', $4, $5, $6, NULL, $7, $8),
                  ($9, $2::uuid, $3::uuid, 'payout', 'clearing', $10, $6, NULL, $7, NULL)
           ON CONFLICT (entry_key) DO NOTHING`,
          [
            `${f.id}:payout:${cuenta}`,
            f.transaction_id,
            f.id,
            cuenta,
            f.amount_cents,
            f.currency,
            guardado.reference,
            `pago manual al ${f.beneficiary_type}`,
            `${f.id}:payout:clearing`,
            -f.amount_cents,
          ],
        );
      }

      await cliente.query('COMMIT');
      return { pago: guardado, partesSaldadas: saldadas.rows.length };
    } catch (e) {
      // El ROLLBACK del camino de arriba ya cerró la transacción; este cubre
      // cualquier otro fallo. Que falle no puede tapar el error original.
      await cliente.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      cliente.release();
    }
  }

  async historial(payeeId: string, limite: number): Promise<Payout[]> {
    const { rows } = await this.pool.query<FilaPago>(
      `SELECT ${COLUMNAS_PAGO} FROM payments.payouts
        WHERE payee_id = $1::uuid
        ORDER BY paid_at DESC LIMIT $2`,
      [payeeId, Math.min(500, Math.max(1, limite))],
    );
    return rows.map(aPago);
  }

  async recientes(limite: number): Promise<Payout[]> {
    const { rows } = await this.pool.query<FilaPago>(
      `SELECT ${COLUMNAS_PAGO} FROM payments.payouts ORDER BY paid_at DESC LIMIT $1`,
      [Math.min(500, Math.max(1, limite))],
    );
    return rows.map(aPago);
  }
}
