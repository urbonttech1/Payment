/**
 * El registro de procesadores.
 *
 * Añadir Square, Adyen, Finix, PayPal o ACH es escribir su adaptador y sumarlo
 * a `montarAdaptadores`. Ni el resto del servicio, ni `urbont-api`, ni la app
 * se enteran.
 */

import { Global, Module } from '@nestjs/common';
import { PAYMENT_PROVIDERS, type PaymentProvider } from './provider.port';
import { ProviderRegistry } from './provider.registry';
import { CONFIG, type Config } from '../config/config';
import { crearStripeProvider } from './stripe/stripe.module';
import { crearSquareProvider } from './square/square.module';

/** Los adaptadores que esta instalación puede usar, según sus credenciales. */
export function montarAdaptadores(config: Config): PaymentProvider[] {
  const posibles: Array<PaymentProvider | null> = [
    crearStripeProvider(config),
    crearSquareProvider(config),
    // crearAdyenProvider(),
  ];
  return posibles.filter((p): p is PaymentProvider => p !== null);
}

@Global()
@Module({
  providers: [
    { provide: PAYMENT_PROVIDERS, inject: [CONFIG], useFactory: montarAdaptadores },
    {
      provide: ProviderRegistry,
      inject: [PAYMENT_PROVIDERS, CONFIG],
      useFactory: (providers: PaymentProvider[], config: Config) =>
        new ProviderRegistry(providers, config.PAYMENT_PROVIDER),
    },
  ],
  exports: [ProviderRegistry, PAYMENT_PROVIDERS],
})
export class ProvidersModule {}
