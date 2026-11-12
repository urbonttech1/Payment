/**
 * El adaptador de Square por dentro.
 *
 * La suite de conformidad ya comprueba las reglas que valen para todos; aquí
 * están las cuatro cosas en las que Square NO funciona como Stripe, que son las
 * que de verdad pueden sorprender el día que se encienda.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SquareError } from 'square';
import type { SquareClient } from 'square';
import { FirmaDeWebhookInvalidaError, PagoRechazadoError, ProcesadorFalloError } from '../provider.port';
import { OperacionNoSoportadaError, SquareProvider } from './square.provider';

const OPCIONES = {
  locationId: 'L1',
  webhookSignatureKey: 'clave',
  webhookNotificationUrl: 'https://payments.urbont.com/webhooks/square',
};

const COBRO = {
  idempotencyKey: 'ride_abc_authorize',
  kind: 'ride' as const,
  amount: 11715,
  currency: 'USD' as const,
  hold: true,
  cardRef: 'cnon:card-nonce-ok',
  reference: { rideId: 'ride-abc', payerId: 'pax-1' },
};

/** Un Square falso que apunta cada llamada, para poder mirar el orden. */
function squareFalso(respuestas: Record<string, unknown> = {}) {
  const llamadas: Array<{ metodo: string; args: unknown[] }> = [];
  const metodo = (nombre: string, devuelve: unknown) =>
    vi.fn((...args: unknown[]) => {
      llamadas.push({ metodo: nombre, args });
      return Promise.resolve(respuestas[nombre] ?? devuelve);
    });

  const pago = { id: 'sqpmt_1', status: 'APPROVED', amountMoney: { amount: 11715n, currency: 'USD' }, totalMoney: { amount: 11715n, currency: 'USD' } };

  const cliente = {
    payments: {
      create: metodo('create', { payment: pago }),
      get: metodo('get', { payment: { ...pago, status: 'COMPLETED' } }),
      update: metodo('update', { payment: pago }),
      complete: metodo('complete', { payment: { ...pago, status: 'COMPLETED' } }),
      cancel: metodo('cancel', { payment: { ...pago, status: 'CANCELED' } }),
      list: metodo('list', paginaDe([])),
    },
    refunds: { refundPayment: metodo('refundPayment', { refund: { id: 'sqref_1', amountMoney: { amount: 500n, currency: 'USD' } } }) },
    cards: { list: metodo('cards.list', { data: [] }) },
    locations: { list: metodo('locations.list', { locations: [] }) },
  } as unknown as SquareClient;

  return { cliente, llamadas };
}

/** Una página de Square: lista y además se puede recorrer con `for await`. */
function paginaDe<T>(items: T[]) {
  return {
    data: items,
    async *[Symbol.asyncIterator]() {
      for (const i of items) yield i;
    },
  };
}

function errorDeSquare(category: string, code = 'ALGO', detail = 'detalle'): SquareError {
  return new SquareError({ message: 'square', statusCode: 400, body: { errors: [{ category, code, detail }] } });
}

describe('cobrar', () => {
  // La diferencia número uno con Stripe: aquí la app tokeniza primero. Crear un
  // cobro sin token dejaría algo que nadie puede confirmar.
  it('SIN TOKEN DE TARJETA SE NIEGA, Y NO LLAMA A SQUARE', async () => {
    const { cliente, llamadas } = squareFalso();
    const p = new SquareProvider(cliente, OPCIONES);

    await expect(p.authorize({ ...COBRO, cardRef: undefined })).rejects.toThrow(OperacionNoSoportadaError);
    expect(llamadas).toHaveLength(0);
  });

  it('retener y cobrar en el acto son el mismo método con el interruptor al revés', async () => {
    const { cliente, llamadas } = squareFalso();
    const p = new SquareProvider(cliente, OPCIONES);

    await p.authorize({ ...COBRO, hold: true });
    expect((llamadas[0].args[0] as { autocomplete: boolean }).autocomplete).toBe(false);

    await p.authorize({ ...COBRO, hold: false });
    expect((llamadas[1].args[0] as { autocomplete: boolean }).autocomplete).toBe(true);
  });

  it('el viaje viaja como referencia, que es la única traza que Square guarda', async () => {
    const { cliente, llamadas } = squareFalso();
    await new SquareProvider(cliente, OPCIONES).authorize({ ...COBRO, metadata: { commission_rate: '0.15' } });

    const cuerpo = llamadas[0].args[0] as { referenceId?: string };
    expect(cuerpo.referenceId).toBe('ride-abc');
    // Y la metadata NO viaja: Square no tiene dónde ponerla. Está probado para
    // que nadie dé por hecho que `urbont-api` podrá leerla del cobro.
    const comoTexto = JSON.stringify(cuerpo, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
    expect(comoTexto).not.toContain('commission_rate');
  });

  it('una retención aprobada no vuelve como cobrada', async () => {
    const { cliente } = squareFalso();
    const a = await new SquareProvider(cliente, OPCIONES).authorize(COBRO);
    expect(a.status).toBe('authorized');
    expect(a.amount).toBe(11715);
  });
});

describe('capturar', () => {
  // La diferencia número dos: `CompletePayment` no acepta importe.
  it('COBRAR MENOS ES BAJAR EL IMPORTE Y LUEGO COMPLETAR, EN ESE ORDEN', async () => {
    const { cliente, llamadas } = squareFalso();
    await new SquareProvider(cliente, OPCIONES).capture({
      idempotencyKey: 'ride_abc_capture',
      providerRef: 'sqpmt_1',
      amount: 5000,
    });

    expect(llamadas.map((l) => l.metodo)).toEqual(['update', 'complete']);
    const ajuste = llamadas[0].args[0] as { payment: { amountMoney: { amount: bigint } }; idempotencyKey: string };
    expect(ajuste.payment.amountMoney.amount).toBe(5000n);
    // El importe entra en la clave: ajustar a 5000 y ajustar a 4000 son dos
    // operaciones distintas, y reusar la clave devolvería el primer ajuste.
    expect(ajuste.idempotencyKey).toContain('5000');
  });

  it('capturar lo autorizado es una sola llamada', async () => {
    const { cliente, llamadas } = squareFalso();
    const c = await new SquareProvider(cliente, OPCIONES).capture({
      idempotencyKey: 'ride_abc_capture',
      providerRef: 'sqpmt_1',
    });

    expect(llamadas.map((l) => l.metodo)).toEqual(['complete']);
    expect(c.captured).toBe(11715);
    // En Square el pago ES el cargo: es lo que aparece en su extracto, y por
    // ahí se concilia.
    expect(c.chargeRef).toBe('sqpmt_1');
  });

  it('subir la autorización es el mismo UpdatePayment, con el nuevo TOTAL', async () => {
    const { cliente, llamadas } = squareFalso();
    await new SquareProvider(cliente, OPCIONES).increaseAuthorization({
      idempotencyKey: 'ride_abc_increase_13000',
      providerRef: 'sqpmt_1',
      amount: 13000,
    });

    const cuerpo = llamadas[0].args[0] as { payment: { amountMoney: { amount: bigint } } };
    expect(llamadas[0].metodo).toBe('update');
    expect(cuerpo.payment.amountMoney.amount).toBe(13000n);
  });
});

describe('reembolsar', () => {
  it('devolverlo todo obliga a preguntar cuánto entró: Square exige el importe', async () => {
    const { cliente, llamadas } = squareFalso();
    await new SquareProvider(cliente, OPCIONES).refund({
      idempotencyKey: 'ride_abc_refund',
      providerRef: 'sqpmt_1',
    });

    expect(llamadas.map((l) => l.metodo)).toEqual(['get', 'refundPayment']);
    const cuerpo = llamadas[1].args[0] as { amountMoney: { amount: bigint } };
    expect(cuerpo.amountMoney.amount).toBe(11715n);
  });

  it('un reembolso parcial no pregunta nada', async () => {
    const { cliente, llamadas } = squareFalso();
    const r = await new SquareProvider(cliente, OPCIONES).refund({
      idempotencyKey: 'ride_abc_refund',
      providerRef: 'sqpmt_1',
      amount: 500,
    });

    expect(llamadas.map((l) => l.metodo)).toEqual(['refundPayment']);
    expect(r.refunded).toBe(500);
  });
});

describe('lo que Square no sabe hacer', () => {
  // La diferencia número tres, y la que más importa: con Square el motor de
  // reparto de hoy no puede pagarle al chofer. Falla a la vista.
  it('TRANSFERIR AL CHOFER FALLA DICIENDO POR QUÉ', async () => {
    const p = new SquareProvider(squareFalso().cliente, OPCIONES);
    await expect(
      p.transfer({ idempotencyKey: 'k', payeeRef: 'payee_1', amount: 7400, currency: 'USD', reference: {} }),
    ).rejects.toThrow(/appFeeMoney/);
  });

  it('dar de alta a un beneficiario también', async () => {
    const p = new SquareProvider(squareFalso().cliente, OPCIONES);
    await expect(p.onboardPayee({ idempotencyKey: 'k', payeeId: 'd1', country: 'US', returnUrl: 'x', refreshUrl: 'y' }))
      .rejects.toThrow(OperacionNoSoportadaError);
    await expect(p.payeeStatus('acct')).rejects.toThrow(OperacionNoSoportadaError);
  });

  it('y lo DICE en sus capacidades, que es lo que impide que el registro lo elija', () => {
    const p = new SquareProvider(squareFalso().cliente, OPCIONES);
    expect(p.capabilities.payouts).toBe(false);
    expect(p.capabilities.splitAtCapture).toBe(false);
  });
});

/**
 * Guardar una tarjeta, que es lo que Square hace al revés que Stripe.
 *
 * Stripe crea un `SetupIntent` en el servidor y la app lo confirma después;
 * Square exige el token por delante y, con él, la tarjeta queda guardada en la
 * misma llamada. Por eso el contrato devuelve una unión: cada procesador acaba
 * en un sitio distinto, y quien llama tiene que saber en cuál.
 */
describe('guardar una tarjeta', () => {
  it('se niega sin token, en vez de dejar un cliente huérfano en Square', async () => {
    const p = new SquareProvider(squareFalso().cliente, OPCIONES);
    // Un `customers.create` sin tarjeta detrás deja basura que nadie vuelve a
    // mirar, y encima haría creer que el alta salió bien.
    await expect(p.saveCard({ idempotencyKey: 'k', payerId: 'pax-1' }))
      .rejects.toThrow(OperacionNoSoportadaError);
  });

  it('con token, la guarda y dice que ya está guardada', async () => {
    const { cliente } = squareFalso();
    cliente.customers = {
      create: async () => ({ customer: { id: 'cus_sq' } }),
    } as never;
    cliente.cards = {
      create: async () => ({
        card: { id: 'ccof_1', cardBrand: 'VISA', last4: '1111', expMonth: 10n, expYear: 2032n },
      }),
    } as never;

    const p = new SquareProvider(cliente, OPCIONES);
    const r = await p.saveCard({ idempotencyKey: 'k', payerId: 'pax-1', cardToken: 'cnon:card-nonce-ok' });

    // El modo es lo que importa: no hay nada que la app tenga que confirmar
    // después, y dar un `clientSecret` inventado sería mentir.
    expect(r.modo).toBe('guardada');
    if (r.modo !== 'guardada') throw new Error('modo inesperado');
    expect(r.customerRef).toBe('cus_sq');
    expect(r.card.providerRef).toBe('ccof_1');
    expect(r.card.last4).toBe('1111');
    expect(r.card.provider).toBe('square');
  });

  it('reusa el cliente que ya tenía: un reintento no crea otro', async () => {
    const { cliente } = squareFalso();
    const crearCliente = vi.fn();
    cliente.customers = { create: crearCliente } as never;
    cliente.cards = {
      create: async () => ({ card: { id: 'ccof_2', cardBrand: 'VISA', last4: '4242', expMonth: 1n, expYear: 2030n } }),
    } as never;

    const p = new SquareProvider(cliente, OPCIONES);
    await p.saveCard({ idempotencyKey: 'k', payerId: 'pax-1', customerRef: 'cus_ya_existia', cardToken: 'cnon:ok' });

    expect(crearCliente).not.toHaveBeenCalled();
  });

  it('declara que sabe guardar tarjetas: el registro lo necesita para elegirlo', () => {
    const p = new SquareProvider(squareFalso().cliente, OPCIONES);
    expect(p.capabilities.savedCards).toBe(true);
  });
});

describe('conciliar', () => {
  it('cuenta lo que quedó: lo cobrado menos lo devuelto, y salta lo no cobrado', async () => {
    const { cliente } = squareFalso({
      list: paginaDe([
        { id: 'sqpmt_1', status: 'COMPLETED', totalMoney: { amount: 11715n, currency: 'USD' }, refundedMoney: { amount: 500n }, amountMoney: { currency: 'USD' }, createdAt: '2026-11-10T12:00:00Z' },
        { id: 'sqpmt_2', status: 'APPROVED', totalMoney: { amount: 9000n, currency: 'USD' }, amountMoney: { currency: 'USD' } },
      ]),
    });

    const lineas = await new SquareProvider(cliente, OPCIONES).listCharges(new Date(0), new Date(), 50);
    expect(lineas).toHaveLength(1);
    expect(lineas[0].netCents).toBe(11215);
  });
});

describe('los avisos de Square', () => {
  it('sin cabecera de firma no se cree nada', async () => {
    const p = new SquareProvider(squareFalso().cliente, OPCIONES);
    await expect(p.parseWebhook({ raw: Buffer.from('{}'), headers: {} })).rejects.toThrow(FirmaDeWebhookInvalidaError);
  });

  // Square firma incluyendo la URL de entrega: sin ella configurada, ninguna
  // firma podría cuadrar, y dar el aviso por bueno sería creerse a cualquiera.
  it('sin la clave y la URL configuradas, tampoco', async () => {
    const p = new SquareProvider(squareFalso().cliente, { locationId: 'L1' });
    await expect(
      p.parseWebhook({ raw: Buffer.from('{}'), headers: { 'x-square-hmacsha256-signature': 'firma' } }),
    ).rejects.toThrow(/clave de firma|URL de entrega/);
  });
});

describe('cómo traduce los errores', () => {
  let p: SquareProvider;

  const conFallo = (e: Error) => {
    const { cliente } = squareFalso();
    (cliente.payments.create as unknown as { mockImplementation: (f: () => Promise<never>) => void })
      .mockImplementation(() => Promise.reject(e));
    return new SquareProvider(cliente, OPCIONES);
  };

  beforeEach(() => {
    p = new SquareProvider(squareFalso().cliente, OPCIONES);
  });

  it('lo que decide el banco es un rechazo, con su código', async () => {
    await conFallo(errorDeSquare('PAYMENT_METHOD_ERROR', 'CARD_DECLINED', 'Rechazada'))
      .authorize(COBRO)
      .catch((e: unknown) => {
        expect(e).toBeInstanceOf(PagoRechazadoError);
        expect((e as PagoRechazadoError).codigo).toBe('CARD_DECLINED');
      });
  });

  it('un reembolso que Square no acepta tampoco se reintenta', async () => {
    const e = await conFallo(errorDeSquare('REFUND_ERROR', 'REFUND_AMOUNT_INVALID')).authorize(COBRO).catch((x) => x);
    expect(e).toBeInstanceOf(PagoRechazadoError);
  });

  // Un error de petición es NUESTRO, y decirle al pasajero que su tarjeta fue
  // rechazada cuando el fallo es de nuestro código es mentirle. Como fallo del
  // procesador, quien llama se cae al camino de siempre y el cobro sale.
  it('UNA PETICIÓN MAL FORMADA ES NUESTRO FALLO, NO UNA TARJETA RECHAZADA', async () => {
    const e = await conFallo(errorDeSquare('INVALID_REQUEST_ERROR', 'MISSING_REQUIRED_PARAMETER')).authorize(COBRO).catch((x) => x);
    expect(e).toBeInstanceOf(ProcesadorFalloError);
  });

  it('y nunca se escapa el error crudo del SDK', async () => {
    const e = await conFallo(new Error('algo raro de la red')).authorize(COBRO).catch((x) => x);
    expect(e).toBeInstanceOf(ProcesadorFalloError);
    expect(p.name).toBe('square');
  });
});
