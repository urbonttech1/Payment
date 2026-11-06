import { Module } from '@nestjs/common';
import { CONFIG, type Config } from '../config/config';
import { ProvidersModule } from '../providers/providers.module';
import { ProviderRegistry } from '../providers/provider.registry';
import { TRANSACTIONS_REPOSITORY, type TransactionsRepository } from '../ledger/transactions.repository';
import { ENTRIES_REPOSITORY, type EntriesRepository } from '../ledger/entries.repository';
import { PAYEES_REPOSITORY, type PayeesRepository } from '../payees/payees.repository';
import { PgPayeesRepository } from '../payees/payees.pg.repository';
import { SPLITS_REPOSITORY, type SplitsRepository } from './splits.repository';
import { PgSplitsRepository } from './splits.pg.repository';
import { SplitsService } from './splits.service';

@Module({
  imports: [ProvidersModule],
  providers: [
    { provide: SPLITS_REPOSITORY, useClass: PgSplitsRepository },
    { provide: PAYEES_REPOSITORY, useClass: PgPayeesRepository },
    {
      provide: SplitsService,
      inject: [ProviderRegistry, TRANSACTIONS_REPOSITORY, SPLITS_REPOSITORY, PAYEES_REPOSITORY, ENTRIES_REPOSITORY, CONFIG],
      useFactory: (
        registry: ProviderRegistry,
        transacciones: TransactionsRepository,
        partes: SplitsRepository,
        beneficiarios: PayeesRepository,
        asientos: EntriesRepository,
        config: Config,
      ) => new SplitsService(registry, transacciones, partes, beneficiarios, asientos, config.PLATFORM_COMMISSION_RATE),
    },
  ],
  exports: [SplitsService, SPLITS_REPOSITORY, PAYEES_REPOSITORY],
})
export class SplitsModule {}
