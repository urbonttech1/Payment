/**
 * Arranque de URBONT PAYMENTS.
 *
 * El orden importa: primero la configuración, después las migraciones y sólo
 * entonces se abre el puerto. Un servicio de pagos que acepta peticiones con el
 * esquema a medias deja cobros huérfanos.
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import type { Pool } from 'pg';
import { AppModule } from './app.module';
import { cargarConfig } from './config/config';
import { POOL } from './db/pool';
import { aplicarMigraciones } from '../db/migrate';

async function arrancar() {
  const config = cargarConfig();

  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    // Los webhooks necesitan el cuerpo CRUDO: si se parsea antes, la firma del
    // procesador ya no se puede verificar y hay que creerse cualquier aviso.
    rawBody: true,
  });
  app.useLogger(app.get(Logger));
  const log = app.get(Logger);

  const pool = app.get<Pool>(POOL);
  await aplicarMigraciones(pool, (m) => log.log(m));

  app.enableShutdownHooks();
  await app.listen(config.PORT, '0.0.0.0');
  log.log(`URBONT PAYMENTS escuchando en :${config.PORT} · procesador por defecto: ${config.PAYMENT_PROVIDER}`);
}

arrancar().catch((e) => {
  console.error('[FATAL] URBONT PAYMENTS no pudo arrancar:', e instanceof Error ? e.message : e);
  process.exit(1);
});
