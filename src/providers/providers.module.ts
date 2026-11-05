/**
 * El registro de procesadores.
 *
 * Añadir Square, Adyen, Finix, PayPal o ACH es añadir su módulo a `adaptadores`
 * y nada más: ni el resto del servicio ni la aplicación de URBONT cambian.
 */

import { Global, Module } from '@nestjs/common';
import { PAYMENT_PROVIDERS, type PaymentProvider } from './provider.port';
import { ProviderRegistry } from './provider.registry';
import { cargarConfig } from '../config/config';

/** Los adaptadores montados. Vacío en la fase 1: el de Stripe llega en la fase 2. */
const adaptadores: PaymentProvider[] = [];

@Global()
@Module({
  providers: [
    { provide: PAYMENT_PROVIDERS, useValue: adaptadores },
    {
      provide: ProviderRegistry,
      inject: [PAYMENT_PROVIDERS],
      useFactory: (providers: PaymentProvider[]) =>
        new ProviderRegistry(providers, cargarConfig().PAYMENT_PROVIDER),
    },
  ],
  exports: [ProviderRegistry, PAYMENT_PROVIDERS],
})
export class ProvidersModule {}
