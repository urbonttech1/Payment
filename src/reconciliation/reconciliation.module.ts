import { Module } from '@nestjs/common';
import { ProvidersModule } from '../providers/providers.module';
import { RECONCILIATION_REPOSITORY } from './reconciliation.repository';
import { PgReconciliationRepository } from './reconciliation.pg.repository';
import { ReconciliationService } from './reconciliation.service';

@Module({
  imports: [ProvidersModule],
  providers: [
    { provide: RECONCILIATION_REPOSITORY, useClass: PgReconciliationRepository },
    ReconciliationService,
  ],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
