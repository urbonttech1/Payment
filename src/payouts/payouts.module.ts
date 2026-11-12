/**
 * El módulo de los pagos que hace una persona.
 *
 * Depende de `SplitsModule` porque lo que se paga sale del reparto: el importe
 * no se calcula aquí, se lee de las partes pendientes.
 */

import { Module } from '@nestjs/common';
import { SplitsModule } from '../splits/splits.module';
import { PayoutsService } from './payouts.service';
import { PgPayoutAccountsRepository, PgPayoutsRepository } from './payouts.pg.repository';
import { PAYOUTS_REPOSITORY, PAYOUT_ACCOUNTS_REPOSITORY } from './payouts.repository';

@Module({
  imports: [SplitsModule],
  providers: [
    PayoutsService,
    { provide: PAYOUT_ACCOUNTS_REPOSITORY, useClass: PgPayoutAccountsRepository },
    { provide: PAYOUTS_REPOSITORY, useClass: PgPayoutsRepository },
  ],
  exports: [PayoutsService],
})
export class PayoutsModule {}
