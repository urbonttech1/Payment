/**
 * Aplica las migraciones del esquema `payments`.
 *
 * Se ejecuta al arrancar el servicio, antes de abrir el puerto, y también a
 * mano con `pnpm migrate`. Los ficheros son idempotentes y se aplican en orden
 * alfabético; cada uno se registra para no repetirlo.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';

/**
 * Dónde están los `.sql`, probando por orden hasta dar con ellos.
 *
 *  1. Junto al compilado (`dist/db/migrations`). Es el caso del contenedor: el
 *     Dockerfile los copia ahí aparte, sin depender del script de build.
 *  2. El original del repositorio (`<raíz>/db/migrations`). Es el caso de
 *     desarrollo, y existe porque `nest build` y `nest start --watch` borran
 *     `dist` y recompilan **sin** copiar los `.sql`: sólo lo hace el último
 *     paso de `npm run build`. Sin este respaldo, arrancar con `npm run dev`
 *     moría con un ENOENT que no decía nada de lo que pasaba.
 *
 * Si no está en ninguno, se dice cuáles se miraron: un servicio de pagos que
 * arranca sin su esquema es peor que uno que no arranca.
 */
function directorioDeMigraciones(): string {
  const candidatos = [
    join(__dirname, 'migrations'),
    join(process.cwd(), 'db', 'migrations'),
  ];
  const encontrado = candidatos.find((d) => existsSync(d));
  if (!encontrado) {
    throw new Error(
      `No encuentro las migraciones. Miré en:\n${candidatos.map((c) => `  · ${c}`).join('\n')}\n` +
        'En local se arregla con `npm run build`, que es quien copia los .sql a dist.',
    );
  }
  return encontrado;
}

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

  const DIRECTORIO = directorioDeMigraciones();
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
