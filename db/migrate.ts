/**
 * Aplica las migraciones del esquema `payments`.
 *
 * Se ejecuta al arrancar el servicio, antes de abrir el puerto, y también a
 * mano con `pnpm migrate`. Los ficheros son idempotentes y se aplican en orden
 * alfabético; cada uno se registra para no repetirlo.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';

const DIRECTORIO = join(__dirname, 'migrations');

export async function aplicarMigraciones(pool: Pool, log: (m: string) => void = console.log): Promise<number> {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS payments;
    CREATE TABLE IF NOT EXISTS payments.schema_migrations (
      nombre     TEXT PRIMARY KEY,
      aplicada_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const { rows } = await pool.query<{ nombre: string }>('SELECT nombre FROM payments.schema_migrations');
  const yaAplicadas = new Set(rows.map((r) => r.nombre));

  const ficheros = readdirSync(DIRECTORIO).filter((f) => f.endsWith('.sql')).sort();
  let aplicadas = 0;

  for (const fichero of ficheros) {
    if (yaAplicadas.has(fichero)) continue;
    const sql = readFileSync(join(DIRECTORIO, fichero), 'utf8');
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      await cliente.query(sql);
      await cliente.query('INSERT INTO payments.schema_migrations (nombre) VALUES ($1)', [fichero]);
      await cliente.query('COMMIT');
      log(`[MIGRACIONES] aplicada ${fichero}`);
      aplicadas++;
    } catch (e) {
      await cliente.query('ROLLBACK');
      throw new Error(`La migración ${fichero} falló: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      cliente.release();
    }
  }

  if (aplicadas === 0) log('[MIGRACIONES] el esquema ya estaba al día');
  return aplicadas;
}

if (require.main === module) {
  (async () => {
    const { crearPool } = await import('../src/db/pool');
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('Falta DATABASE_URL');
    const pool = crearPool(url);
    await aplicarMigraciones(pool);
    await pool.end();
  })().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
