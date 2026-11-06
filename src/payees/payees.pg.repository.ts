import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { POOL } from '../db/pool';
import type { PayeeStatus, ProviderName } from '../providers/provider.port';
import { CuentaDeOtraPersonaError, type NuevoPayee, type Payee, type PayeesRepository } from './payees.repository';

interface Fila {
  id: string;
  payee_id: string;
  payee_type: string;
  provider: string;
  provider_ref: string;
  status: string;
  country: string;
  checked_at: Date | null;
}

const COLUMNAS = 'id, payee_id, payee_type, provider, provider_ref, status, country, checked_at';

function aPayee(f: Fila): Payee {
  return {
    id: f.id,
    payeeId: f.payee_id,
    payeeType: f.payee_type as Payee['payeeType'],
    provider: f.provider as ProviderName,
    providerRef: f.provider_ref,
    status: f.status as PayeeStatus,
    country: f.country,
    checkedAt: f.checked_at,
  };
}

/** 23505 es el `unique_violation` de Postgres. */
function esViolacionDeUnico(e: unknown): boolean {
  return !!e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === '23505';
}

@Injectable()
export class PgPayeesRepository implements PayeesRepository {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  async registrarSiFalta(nuevo: NuevoPayee): Promise<{ payee: Payee; yaExistia: boolean }> {
    // Hay DOS índices únicos en esta tabla, y el `ON CONFLICT` sólo puede
    // nombrar uno: `(payee_id, provider)`, que es el caso normal —la persona ya
    // tenía cuenta— y se resuelve sin excepción. El otro,
    // `(provider, provider_ref)`, sí lanza, y hay que atraparlo: significa que
    // esa cuenta de cobro es de otra persona, que es un dato que alguien tiene
    // que corregir y no un 500.
    try {
      const insercion = await this.pool.query<Fila>(
        `INSERT INTO payments.payees (payee_id, payee_type, provider, provider_ref, status, country)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (payee_id, provider) DO NOTHING
         RETURNING ${COLUMNAS}`,
        [
          nuevo.payeeId,
          nuevo.payeeType,
          nuevo.provider,
          nuevo.providerRef,
          nuevo.status ?? 'pending',
          nuevo.country ?? 'US',
        ],
      );

      if (insercion.rows[0]) return { payee: aPayee(insercion.rows[0]), yaExistia: false };
    } catch (e) {
      if (!esViolacionDeUnico(e)) throw e;
    }

    const existente = await this.porPersona(nuevo.payeeId, nuevo.provider);
    if (existente) return { payee: existente, yaExistia: true };

    throw new CuentaDeOtraPersonaError(nuevo.provider, nuevo.providerRef);
  }

  async porPersona(payeeId: string, provider: ProviderName): Promise<Payee | null> {
    const { rows } = await this.pool.query<Fila>(
      `SELECT ${COLUMNAS} FROM payments.payees WHERE payee_id = $1 AND provider = $2`,
      [payeeId, provider],
    );
    return rows[0] ? aPayee(rows[0]) : null;
  }

  async actualizarCuenta(payeeId: string, provider: ProviderName, providerRef: string): Promise<Payee> {
    // La cuenta cambia y el estado vuelve a 'pending': la cuenta nueva no
    // hereda el «activa» de la vieja, que es de otra cuenta.
    return this.actualizar(
      `UPDATE payments.payees
          SET provider_ref=$3, status='pending', checked_at=NULL, updated_at=NOW()
        WHERE payee_id=$1 AND provider=$2 RETURNING ${COLUMNAS}`,
      [payeeId, provider, providerRef],
    );
  }

  async actualizarEstado(payeeId: string, provider: ProviderName, status: PayeeStatus): Promise<Payee> {
    return this.actualizar(
      `UPDATE payments.payees
          SET status=$3, checked_at=NOW(), updated_at=NOW()
        WHERE payee_id=$1 AND provider=$2 RETURNING ${COLUMNAS}`,
      [payeeId, provider, status],
    );
  }

  private async actualizar(sql: string, params: unknown[]): Promise<Payee> {
    const { rows } = await this.pool.query<Fila>(sql, params);
    if (!rows[0]) {
      throw new Error(`No hay beneficiario ${String(params[0])} en ${String(params[1])}`);
    }
    return aPayee(rows[0]);
  }
}
