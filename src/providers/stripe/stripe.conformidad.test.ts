/**
 * El adaptador de Stripe, contra la suite de conformidad.
 *
 * Es el ejemplo a copiar cuando se escriba el segundo adaptador: implementar
 * este arnés y llamar a `pruebasDeConformidad`. Si el adaptador nuevo pasa esto,
 * cumple las reglas de URBONT; si no, lo dice antes de tocar producción.
 */

import { vi } from 'vitest';
import Stripe from 'stripe';
import type { PaymentProvider } from '../provider.port';
import { pruebasDeConformidad, type ArnesDeConformidad } from '../conformidad';
import { StripeProvider } from './stripe.provider';

/** Lo último que se le pidió a Stripe: cuerpo y opciones, sin interpretar. */
let ultima: unknown = null;

function stripeFalso(fallo?: Error) {
  const registra = (devuelve: unknown) =>
    vi.fn((...args: unknown[]) => {
      ultima = args;
      return fallo ? Promise.reject(fallo) : Promise.resolve(devuelve);
    });

  return {
    paymentIntents: {
      create: registra({ id: 'pi_1', status: 'requires_capture', amount: 11000, currency: 'usd', client_secret: 'pi_1_secret' }),
      capture: registra({ id: 'pi_1', status: 'succeeded', amount: 11000, amount_received: 11000, currency: 'usd', latest_charge: 'ch_1' }),
      cancel: registra({ id: 'pi_1', status: 'canceled', amount: 11000, currency: 'usd' }),
      retrieve: registra({ id: 'pi_1', status: 'succeeded', amount: 11000, currency: 'usd', latest_charge: 'ch_1' }),
      update: registra({ id: 'pi_1', status: 'requires_capture', amount: 12000, currency: 'usd' }),
    },
    refunds: { create: registra({ id: 're_1', amount: 11000, currency: 'usd' }) },
    transfers: { create: registra({ id: 'tr_1', amount: 9000, currency: 'usd' }) },
    accounts: { create: registra({ id: 'acct_1' }), retrieve: registra({ id: 'acct_1', capabilities: { transfers: 'active' } }) },
    accountLinks: { create: registra({ url: 'https://onboarding' }) },
    customers: { create: registra({ id: 'cus_1' }), retrieve: registra({ id: 'cus_1' }) },
    setupIntents: { create: registra({ id: 'seti_1', client_secret: 'seti_1_secret' }) },
    paymentMethods: { list: registra({ data: [] }), retrieve: registra({ id: 'pm_1' }) },
    charges: { list: vi.fn(() => ({ autoPagingToArray: async () => [] })) },
    terminal: { connectionTokens: { create: registra({ secret: 'pst_test_1' }) } },
    balance: { retrieve: registra({ object: 'balance' }) },
    webhooks: {
      constructEvent: vi.fn(() => {
        throw new Error('firma inválida');
      }),
    },
  } as unknown as Stripe;
}

/** Un rechazo de tarjeta tal como lo lanza el SDK de Stripe. */
function rechazoDeTarjeta(): Error {
  const e = new Stripe.errors.StripeCardError({
    type: 'card_error',
    message: 'Your card was declined.',
    code: 'card_declined',
  });
  return e;
}

function falloDeStripe(): Error {
  return new Stripe.errors.StripeAPIError({
    type: 'api_error',
    message: 'Stripe se cayó',
  });
}

const arnes: ArnesDeConformidad = {
  nombre: 'Stripe',
  montar: (): PaymentProvider => new StripeProvider(stripeFalso(), ['whsec_test']),
  ultimaPeticion: () => ultima,
  montarConRechazo: (): PaymentProvider => new StripeProvider(stripeFalso(rechazoDeTarjeta()), ['whsec_test']),
  montarConFalloDelProcesador: (): PaymentProvider => new StripeProvider(stripeFalso(falloDeStripe()), ['whsec_test']),
};

pruebasDeConformidad(arnes);
