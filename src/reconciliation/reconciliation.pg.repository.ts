import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { POOL } from '../db/pool';
import type { CuadreParaGuardar, ReconciliationRepository } from './reconciliation.repository';

/** Lo que cabe en la columna: los descuadres de un cuadre roto pueden ser miles. */
const MAXIMOS_GUARDADOS = 500;

@Injectable()
export class PgReconciliationRepository implements ReconciliationRepository {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  async guardar(cuadre: CuadreParaGuardar): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO payments.reconciliation_runs
         (provider, periodo_inicio, periodo_fin, cobros_proveedor, cobros_propios,
          centavos_proveedor, centavos_propios, descuadres, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
       RETURNING id`,
      [
        cuadre.provider,
        cuadre.desde,
        cuadre.hasta,
        cuadre.cobrosProcesador,
        cuadre.cobrosPropios,
        cuadre.centavosProcesador,
        cuadre.centavosPropios,
        // Recortados, pero diciendo cuántos había: un cuadre con 40.000
        // descuadres no puede tumbar la base al guardarse, y el número total
        // es lo primero que alguien necesita saber.
        JSON.stringify({
          total: cuadre.descuadres.length,
          muestra: cuadre.descuadres.slice(0, MAXIMOS_GUARDADOS),
        }),
        cuadre.cuadra ? 'ok' : 'descuadre',
      ],
    );
    return rows[0].id;
  }
}
