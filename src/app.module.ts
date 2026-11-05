import { Global, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { crearPool, POOL } from './db/pool';
import { cargarConfig, type Config } from './config/config';
import { HealthModule } from './health/health.module';
import { ProvidersModule } from './providers/providers.module';
import { LedgerModule } from './ledger/ledger.module';
import { PaymentsModule } from './payments/payments.module';

export const CONFIG = Symbol('CONFIG');

@Global()
@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        base: { service: 'urbont-payments' },
        // Nunca en el registro: son credenciales y datos de tarjeta.
        redact: ['req.headers.authorization', 'req.headers["x-urbont-signature"]', 'req.headers["stripe-signature"]'],
        transport: process.env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
      },
    }),
    HealthModule,
    ProvidersModule,
    LedgerModule,
    PaymentsModule,
  ],
  providers: [
    { provide: CONFIG, useFactory: (): Config => cargarConfig() },
    {
      provide: POOL,
      inject: [CONFIG],
      useFactory: (config: Config) => crearPool(config.DATABASE_URL),
    },
  ],
  exports: [CONFIG, POOL],
})
export class AppModule {}
