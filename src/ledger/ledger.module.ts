import { Global, Module } from '@nestjs/common';
import { TRANSACTIONS_REPOSITORY } from './transactions.repository';
import { PgTransactionsRepository } from './transactions.pg.repository';
import { ENTRIES_REPOSITORY } from './entries.repository';
import { PgEntriesRepository } from './entries.pg.repository';

@Global()
@Module({
  providers: [
    { provide: TRANSACTIONS_REPOSITORY, useClass: PgTransactionsRepository },
    { provide: ENTRIES_REPOSITORY, useClass: PgEntriesRepository },
  ],
  exports: [TRANSACTIONS_REPOSITORY, ENTRIES_REPOSITORY],
})
export class LedgerModule {}
