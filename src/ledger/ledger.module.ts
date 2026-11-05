import { Global, Module } from '@nestjs/common';
import { TRANSACTIONS_REPOSITORY } from './transactions.repository';
import { PgTransactionsRepository } from './transactions.pg.repository';

@Global()
@Module({
  providers: [{ provide: TRANSACTIONS_REPOSITORY, useClass: PgTransactionsRepository }],
  exports: [TRANSACTIONS_REPOSITORY],
})
export class LedgerModule {}
