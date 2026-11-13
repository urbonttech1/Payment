/**
 * El adaptador de Square, contra la misma suite que Stripe.
 *
 * Es la prueba de que el contrato sirve: el mismo arnés, las mismas reglas, y un
 * procesador que por dentro funciona distinto —tokeniza en la app, no transfiere
 * a terceros, no captura importes— pasa igual.
 *
 * Lo único que cambia es `extras`: Square no puede crear un cobro sin un token
 * de tarjeta, así que el arnés lo dice. Las reglas no se relajan.
 */

import { vi } from 'vitest';
import { SquareError } from 'square';
import type { PaymentProvider } from '../provider.port';
import { pruebasDeConformidad, type ArnesDeConformidad } from '../conformidad';
import { SquareProvider } from './square.provider';
import { LIMITE_CLAVE_SQUARE, claveDeSquare } from './square.mapper';
import type { SquareClient } from 'square';

/** Lo último que se le pidió a Square: cuerpo y opciones, sin interpretar. */
let ultima: unknown = null;

const PAGO_APROBADO = {
  id: 'sqpmt_1',
  status: 'APPROVED',
  amountMoney: { amount: 11000n, currency: 'USD' },
  totalMoney: { amount: 11000n, currency: 'USD' },
};

const PAGO_COMPLETO = { ...PAGO_APROBADO, status: 'COMPLETED' };

/** El pago que dejaría el SDK del teléfono: completo, en nuestra location y con el viaje por referencia. */
const PAGO_DEL_TELEFONO = { ...PAGO_COMPLETO, id: 'sqpmt_tap_1', locationId: 'L1', referenceId: 'ride-conformidad' };

function squareFalso(fallo?: Error, pagoDeGet: unknown = PAGO_COMPLETO): SquareClient {
  const registra = (devuelve: unknown) =>
    vi.fn((...args: unknown[]) => {
      ultima = args;
      return fallo ? Promise.reject(fallo) : Promise.resolve(devuelve);
    });

  return {
    payments: {
      create: registra({ payment: PAGO_APROBADO }),
      get: registra({ payment: pagoDeGet }),
      update: registra({ payment: { ...PAGO_APROBADO, amountMoney: { amount: 12000n, currency: 'USD' } } }),
      complete: registra({ payment: PAGO_COMPLETO }),
      cancel: registra({ payment: { ...PAGO_APROBADO, status: 'CANCELED' } }),
      list: registra({ data: [], [Symbol.asyncIterator]: async function* () {} }),
    },
    refunds: {
      refundPayment: registra({ refund: { id: 'sqref_1', status: 'COMPLETED', amountMoney: { amount: 11000n, currency: 'USD' } } }),
    },
    cards: { list: registra({ data: [] }) },
    locations: { list: registra({ locations: [{ id: 'L1' }] }) },
  } as unknown as SquareClient;
}

/** Un rechazo de tarjeta tal como lo lanza el SDK de Square. */
function rechazoDeTarjeta(): Error {
  return new SquareError({
    message: 'Card declined',
    statusCode: 402,
    body: { errors: [{ category: 'PAYMENT_METHOD_ERROR', code: 'CARD_DECLINED', detail: 'La tarjeta fue rechazada.' }] },
  });
}

function falloDeSquare(): Error {
  return new SquareError({
    message: 'Square se cayó',
    statusCode: 500,
    body: { errors: [{ category: 'API_ERROR', code: 'INTERNAL_SERVER_ERROR', detail: 'Algo falló en Square.' }] },
  });
}

const OPCIONES = {
  locationId: 'L1',
  webhookSignatureKey: 'clave_de_firma',
  webhookNotificationUrl: 'https://payments.urbont.com/webhooks/square',
};

const arnes: ArnesDeConformidad = {
  nombre: 'Square',
  // Square rechaza claves de más de 45 caracteres y las de urbont-api miden 51–67:
  // el adaptador las acorta con un hash determinista.
  limiteDeClave: LIMITE_CLAVE_SQUARE,
  claveEnviada: claveDeSquare,
  montar: (): PaymentProvider => new SquareProvider(squareFalso(), OPCIONES),
  ultimaPeticion: () => ultima,
  // Square no tiene cobro que la app confirme después: el token de la tarjeta
  // va en la creación o no hay cobro.
  extras: { cardRef: 'cnon:card-nonce-ok' },
  montarConRechazo: (): PaymentProvider => new SquareProvider(squareFalso(rechazoDeTarjeta()), OPCIONES),
  montarConFalloDelProcesador: (): PaymentProvider => new SquareProvider(squareFalso(falloDeSquare()), OPCIONES),
};

pruebasDeConformidad(arnes);

/**
 * Square con credenciales OAuth: anuncia Tap to Pay, y por tanto la suite le exige
 * las dos mitades. No tiene `presentCharge` —el cobro lo crea el teléfono—, así que
 * lo que se le exige en su lugar es poder **adoptar** el pago.
 */
const oauth = () => ({
  applicationId: 'sq0idp-APP',
  applicationSecret: 'sq0csp-SECRETO',
  refreshToken: 'EQAAREFRESH',
  client: {
    oAuth: {
      obtainToken: vi.fn(async () => ({ accessToken: 'EAAAshort', expiresAt: '2026-11-14T00:00:00Z' })),
    },
  } as unknown as SquareClient,
});

pruebasDeConformidad({
  ...arnes,
  nombre: 'Square (con Tap to Pay)',
  montar: (): PaymentProvider => new SquareProvider(squareFalso(), OPCIONES, oauth()),
  montarConRechazo: (): PaymentProvider => new SquareProvider(squareFalso(rechazoDeTarjeta()), OPCIONES, oauth()),
  montarConFalloDelProcesador: (): PaymentProvider => new SquareProvider(squareFalso(falloDeSquare()), OPCIONES, oauth()),
  adopcion: {
    montar: (): PaymentProvider => new SquareProvider(squareFalso(undefined, PAGO_DEL_TELEFONO), OPCIONES, oauth()),
    providerRef: 'sqpmt_tap_1',
    esperado: { amount: 11000, currency: 'USD', reference: 'ride-conformidad' },
  },
});
