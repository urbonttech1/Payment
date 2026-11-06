/**
 * El módulo del adaptador de Stripe.
 *
 * Si no hay `STRIPE_SECRET_KEY`, el adaptador no se monta y el servicio arranca
 * igual: en el registro aparecerá que Stripe no está disponible, en vez de
 * fallar al primer cobro con un error de credenciales.
 */

import { Module } from '@nestjs/common';
import Stripe from 'stripe';
import { CONFIG, type Config } from '../../config/config';
import { StripeProvider } from './stripe.provider';

export const STRIPE_PROVIDER = Symbol('STRIPE_PROVIDER');

/**
 * El adaptador, o `null` si esta instalación no tiene credenciales de Stripe.
 *
 * La configuración llega como argumento y no se lee de `process.env` aquí: así
 * el grafo de módulos no depende del entorno del proceso, y se puede levantar
 * el servicio en una prueba sin inventarle un entorno completo.
 */
export function crearStripeProvider(config: Config): StripeProvider | null {
  if (!config.STRIPE_SECRET_KEY) return null;

  const stripe = new Stripe(config.STRIPE_SECRET_KEY, {
    // Sin `apiVersion`, el SDK usa la que trae fijada su propia versión, que es
    // la que sus tipos describen. Escribir una distinta a mano desajusta tipos y
    // respuestas, y es un desajuste que sólo se nota en producción.
    maxNetworkRetries: 2,
    timeout: 20_000,
    appInfo: { name: 'URBONT PAYMENTS', version: '0.1.0' },
  });

  const secretos = [config.STRIPE_WEBHOOK_SECRET, config.STRIPE_WEBHOOK_SECRET_CONNECT]
    .filter((s): s is string => !!s);

  return new StripeProvider(stripe, secretos);
}

@Module({
  providers: [{ provide: STRIPE_PROVIDER, inject: [CONFIG], useFactory: crearStripeProvider }],
  exports: [STRIPE_PROVIDER],
})
export class StripeModule {}
