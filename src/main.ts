/**
 * Arranque de URBONT PAYMENTS.
 *
 * El orden importa: primero el `.env`, después la configuración, luego las
 * migraciones y sólo entonces se abre el puerto. Un servicio de pagos que
 * acepta peticiones con el esquema a medias deja cobros huérfanos.
 */

// Sólo para desarrollo local: en producción no hay `.env` —el Dockerfile no lo
// copia y ECS inyecta las variables directamente— así que esto no hace nada
// salvo cuando se arranca a mano. Sin esto, `npm run dev` leía `process.env`
// tal cual y el `.env` del repositorio no era más que un papel.
import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import type { Pool } from 'pg';
import { AppModule } from './app.module';
import { cargarConfig } from './config/config';
import { POOL } from './db/pool';
import { aplicarMigraciones } from '../db/migrate';
import { VERSION } from './version';
import { lineaDeArranque } from './arranque';
import { ProviderRegistry } from './providers/provider.registry';

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
  // Del registro y no del entorno: a estas alturas las credenciales guardadas ya
  // montaron sus pasarelas y el panel ya eligió la suya.
  const registro = app.get(ProviderRegistry);
  log.log(
    lineaDeArranque({
      version: VERSION,
      puerto: config.PORT,
      porDefecto: registro.porDefecto,
      montados: registro.disponibles(),
    }),
  );
}

arrancar().catch((e) => {
  console.error('[FATAL] URBONT PAYMENTS no pudo arrancar:', e instanceof Error ? e.message : e);
  process.exit(1);
});
