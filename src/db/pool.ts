/**
 * El pool de Postgres del servicio.
 *
 * Apunta al mismo Postgres que el resto de URBONT, pero el usuario con el que
 * se conecta sólo tiene permisos sobre el esquema `payments`: un fallo aquí no
 * puede tocar los viajes ni los perfiles.
 */

import { Pool, type PoolConfig } from 'pg';

/**
 * Si la conexión va cifrada, leído de la propia cadena como hace `libpq`.
 *
 * Antes se decidía por si el host decía «localhost», que falla en cuanto el
 * servicio corre en un contenedor y la base está en `host.docker.internal`.
 * `sslmode` es el parámetro estándar y es explícito: quien escribe la cadena
 * dice lo que quiere.
 *
 * Por defecto va cifrado, con el certificado sin verificar: Supabase presenta
 * uno que no encadena con las CA del sistema.
 *
 * **En la cadena se escribe `sslmode=no-verify`, nunca `require`.** Desde pg
 * 8.16 `require` es un alias de `verify-full`, y eso lo aplica el propio `pg`
 * al parsear la cadena, por encima de lo que devuelva esta función: con
 * `require`, la conexión a Supabase muere con «self-signed certificate in
 * certificate chain». Costó un despliegue descubrirlo.
 */
export function opcionesSsl(databaseUrl: string): PoolConfig['ssl'] {
  const modo = /[?&]sslmode=([^&]+)/.exec(databaseUrl)?.[1];
  if (modo === 'disable') return undefined;
  if (modo === 'verify-full' || modo === 'verify-ca') return { rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

export function crearPool(databaseUrl: string): Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: opcionesSsl(databaseUrl),
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // El esquema propio primero, y `public` para poder conciliar contra `rides`.
    options: '-c search_path=payments,public',
  });

  // Sin esto, el proceso se muere.
  //
  // `pg` emite 'error' en el pool por cuenta de las conexiones ociosas que se
  // rompen —la base se reinicia, el cortafuegos corta una conexión parada, el
  // proveedor hace mantenimiento— y en Node un 'error' sin oyente es una
  // excepción no capturada que tumba el servicio entero. Comprobado: basta con
  // parar Postgres un segundo para que el contenedor se caiga.
  //
  // El pool se recupera solo abriendo conexiones nuevas; lo único que hace
  // falta es no morirse mientras tanto.
  pool.on('error', (err) => {
    console.error(`[POOL] conexión ociosa perdida: ${err.message}`);
  });

  return pool;
}

export const POOL = Symbol('POOL');
