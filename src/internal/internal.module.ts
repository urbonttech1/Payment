import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { SplitsModule } from '../splits/splits.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { PayoutsModule } from '../payouts/payouts.module';
import { ProvidersModule } from '../providers/providers.module';
import { CardsController } from './cards.controller';
import { ChargesController } from './charges.controller';
import { OperacionesController } from './operaciones.controller';
import { PayoutsController } from './payouts.controller';
import { TerminalController } from './terminal.controller';
import { ErroresDePagoFilter } from './errores.filter';
import { FirmaGuard } from './firma.guard';
import { PreferredCardsRepository } from './preferred-cards.repository';

/**
 * Lo que `urbont-api` puede llamar. Nada de aquí lo llama la app.
 */
@Module({
  imports: [PaymentsModule, SplitsModule, WebhooksModule, ReconciliationModule, PayoutsModule, ProvidersModule],
  controllers: [CardsController, ChargesController, OperacionesController, PayoutsController, TerminalController],
  providers: [FirmaGuard, ErroresDePagoFilter, PreferredCardsRepository],
})
export class InternalModule {}
