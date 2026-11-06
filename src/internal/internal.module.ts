import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { SplitsModule } from '../splits/splits.module';
import { ChargesController } from './charges.controller';
import { ErroresDePagoFilter } from './errores.filter';
import { FirmaGuard } from './firma.guard';

/**
 * Lo que `urbont-api` puede llamar. Nada de aquí lo llama la app.
 */
@Module({
  imports: [PaymentsModule, SplitsModule],
  controllers: [ChargesController],
  providers: [FirmaGuard, ErroresDePagoFilter],
})
export class InternalModule {}
