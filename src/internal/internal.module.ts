import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { SplitsModule } from '../splits/splits.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { ChargesController } from './charges.controller';
import { OperacionesController } from './operaciones.controller';
import { ErroresDePagoFilter } from './errores.filter';
import { FirmaGuard } from './firma.guard';

/**
 * Lo que `urbont-api` puede llamar. Nada de aquí lo llama la app.
 */
@Module({
  imports: [PaymentsModule, SplitsModule, WebhooksModule, ReconciliationModule],
  controllers: [ChargesController, OperacionesController],
  providers: [FirmaGuard, ErroresDePagoFilter],
})
export class InternalModule {}
