import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { ChargesController } from './charges.controller';
import { ErroresDePagoFilter } from './errores.filter';
import { FirmaGuard } from './firma.guard';

/**
 * Lo que `urbont-api` puede llamar. Nada de aquí lo llama la app.
 */
@Module({
  imports: [PaymentsModule],
  controllers: [ChargesController],
  providers: [FirmaGuard, ErroresDePagoFilter],
})
export class InternalModule {}
