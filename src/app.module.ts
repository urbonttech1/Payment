import { Global, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { crearPool, POOL } from './db/pool';
import { CONFIG, cargarConfig, type Config } from './config/config';
import { SettingsModule } from './config/settings.module';
import { HealthModule } from './health/health.module';
import { ProvidersModule } from './providers/providers.module';
import { LedgerModule } from './ledger/ledger.module';
import { PaymentsModule } from './payments/payments.module';
import { SplitsModule } from './splits/splits.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { InternalModule } from './internal/internal.module';
import { configuracionDeLogs } from './logging/logging.config';

export { CONFIG };

@Global()
@Module({
  imports: [
    // Qué se registra y con qué forma, en `logging/`: texto legible por defecto y
    // JSON con `LOG_FORMAT=json`; las sondas del balanceador no se registran.
    LoggerModule.forRoot({ pinoHttp: configuracionDeLogs() }),
    HealthModule,
    ProvidersModule,
    SettingsModule,
    LedgerModule,
    PaymentsModule,
    SplitsModule,
    WebhooksModule,
    ReconciliationModule,
    InternalModule,
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
