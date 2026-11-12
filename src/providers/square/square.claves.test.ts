/**
 * Las claves de idempotencia y el límite de Square.
 *
 * Square rechaza cualquier clave de más de 45 caracteres con
 * «Field must not be greater than 45 length». Las que genera urbont-api son más
 * largas —`ride_<uuid>_authorize` son 51, y con `_capture` o `_refund` pasan de
 * 58—, y el adaptador las mandaba tal cual. Esto se vio en producción como una
 * ristra de 502 en `POST /internal/cards`, y habría roto igual cada cobro, captura
 * y reembolso por Square: no se había notado sólo porque todavía ningún flujo
 * pasa por el micro.
 *
 * El Square de mentira de aquí **hace lo que hace el de verdad**: rechaza lo que
 * pasa de 45. Antes el de las pruebas dejaba pasar cualquier clave, y por eso la
 * suite de conformidad no lo pudo cazar.
 */

import { describe, expect, it, vi } from 'vitest';
import { SquareError } from 'square';
import type { SquareClient } from 'square';
import { SquareProvider } from './square.provider';
import { LIMITE_CLAVE_SQUARE, claveDeSquare } from './square.mapper';

/**
 * El límite de Square, **escrito aquí a mano** y no importado del adaptador: el
 * Square de mentira modela al Square de verdad, y si compartiera la constante con
 * el código que prueba, un fallo al importarla la dejaría `undefined` y
 * `largo > undefined` es siempre falso: el fake dejaría de rechazar nada y todas
 * las pruebas pasarían sin probar nada. (Pasó: al escribirlas, antes de que la
 * constante existiera, cinco pruebas salían en verde con el fallo sin arreglar.)
 */
const LIMITE_REAL_DE_SQUARE = 45;

/** Un viaje de verdad: así de largo es el UUID en las claves que genera urbont-api. */
const VIAJE = '8e2d4a1b-5c3f-4a7e-9b1d-2f6c8e0a4b7d';
const CLAVE_DEL_COBRO = `ride_${VIAJE}_authorize`;      // 51: lo que manda urbont-api

function errorDeLargo(): SquareError {
  return new SquareError({
    message: 'Field must not be greater than 45 length',
    statusCode: 400,
    body: {
      errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'VALUE_TOO_LONG', detail: 'Field must not be greater than 45 length' }],
    },
  });
}

/** Un Square que RECHAZA las claves largas, y que apunta lo que se le mandó. */
function squareEstricto() {
  const claves: Array<{ metodo: string; clave: string }> = [];
  const cabeceras: Array<{ metodo: string; clave: string | undefined }> = [];

  const conClave = (metodo: string, salida: unknown) =>
    vi.fn((req: { idempotencyKey?: string }) => {
      const clave = req?.idempotencyKey ?? '';
      claves.push({ metodo, clave });
      if (clave.length > LIMITE_REAL_DE_SQUARE) return Promise.reject(errorDeLargo());
      return Promise.resolve(salida);
    });

  const conCabecera = (metodo: string, salida: unknown) =>
    vi.fn((_req: unknown, opciones?: { headers?: Record<string, string> }) => {
      cabeceras.push({ metodo, clave: opciones?.headers?.['Idempotency-Key'] });
      return Promise.resolve(salida);
    });

  const pago = { id: 'sqpmt_1', status: 'APPROVED', amountMoney: { amount: 11000n, currency: 'USD' }, totalMoney: { amount: 11000n, currency: 'USD' } };

  const cliente = {
    payments: {
      create: conClave('payments.create', { payment: pago }),
      update: conClave('payments.update', { payment: pago }),
      complete: conCabecera('payments.complete', { payment: { ...pago, status: 'COMPLETED' } }),
      cancel: conCabecera('payments.cancel', { payment: { ...pago, status: 'CANCELED' } }),
      get: vi.fn(() => Promise.resolve({ payment: { ...pago, status: 'COMPLETED' } })),
    },
    refunds: {
      refundPayment: conClave('refunds.refundPayment', { refund: { id: 'sqref_1', amountMoney: { amount: 500n, currency: 'USD' } } }),
    },
    customers: { create: conClave('customers.create', { customer: { id: 'sqcus_1' } }) },
    cards: {
      create: conClave('cards.create', { card: { id: 'ccof:1', cardBrand: 'VISA', last4: '1111', expMonth: 12n, expYear: 2030n } }),
    },
  } as unknown as SquareClient;

  return { cliente, claves, cabeceras };
}

const OPCIONES = { locationId: 'L1' };

const COBRO = {
  idempotencyKey: CLAVE_DEL_COBRO,
  kind: 'ride' as const,
  amount: 11000,
  currency: 'USD' as const,
  hold: true,
  cardRef: 'cnon:card-nonce-ok',
  reference: { rideId: VIAJE, payerId: 'pax-1' },
};

describe('con las claves REALES de urbont-api, Square no las rechaza', () => {
  it('lo que generamos de verdad pasa de 45, que es el problema', () => {
    expect(CLAVE_DEL_COBRO.length).toBe(51);
    expect(`${CLAVE_DEL_COBRO}_capture`.length).toBeGreaterThan(LIMITE_REAL_DE_SQUARE);
    expect(`${CLAVE_DEL_COBRO}_refund`.length).toBeGreaterThan(LIMITE_REAL_DE_SQUARE);
  });

  it('AUTORIZAR un cobro del viaje', async () => {
    const { cliente } = squareEstricto();
    const a = await new SquareProvider(cliente, OPCIONES).authorize(COBRO);
    expect(a.status).toBe('authorized');
  });

  it('CAPTURAR menos de lo autorizado (ajuste + completar)', async () => {
    const { cliente } = squareEstricto();
    const c = await new SquareProvider(cliente, OPCIONES).capture({
      idempotencyKey: `${CLAVE_DEL_COBRO}_capture`,
      providerRef: 'sqpmt_1',
      amount: 9000,
    });
    expect(c.provider).toBe('square');
  });

  it('SUBIR la autorización (el cargo por espera)', async () => {
    const { cliente } = squareEstricto();
    await expect(
      new SquareProvider(cliente, OPCIONES).increaseAuthorization({
        idempotencyKey: `${CLAVE_DEL_COBRO}_increase_13000`,
        providerRef: 'sqpmt_1',
        amount: 13000,
      }),
    ).resolves.toBeDefined();
  });

  it('REEMBOLSAR', async () => {
    const { cliente } = squareEstricto();
    const r = await new SquareProvider(cliente, OPCIONES).refund({
      idempotencyKey: `${CLAVE_DEL_COBRO}_refund`,
      providerRef: 'sqpmt_1',
      amount: 500,
    });
    expect(r.refunded).toBe(500);
  });

  // El caso de los 502 de producción.
  it('GUARDAR UNA TARJETA: el cliente y la tarjeta', async () => {
    const { cliente } = squareEstricto();
    const r = await new SquareProvider(cliente, OPCIONES).saveCard({
      idempotencyKey: `card_${VIAJE}_${VIAJE}`,           // 77 caracteres
      payerId: `passenger_${VIAJE}`,                       // `customer_` + 46 = 55
      cardToken: 'cnon:card-nonce-ok',
    });
    expect(r.modo).toBe('guardada');
  });

  it('TODAS las claves que llegaron a Square caben en el límite', async () => {
    const { cliente, claves } = squareEstricto();
    const p = new SquareProvider(cliente, OPCIONES);
    await p.authorize(COBRO);
    await p.capture({ idempotencyKey: `${CLAVE_DEL_COBRO}_capture`, providerRef: 'sqpmt_1', amount: 9000 });
    await p.increaseAuthorization({ idempotencyKey: `${CLAVE_DEL_COBRO}_increase_13000`, providerRef: 'sqpmt_1', amount: 13000 });
    await p.refund({ idempotencyKey: `${CLAVE_DEL_COBRO}_refund`, providerRef: 'sqpmt_1', amount: 500 });
    await p.saveCard({ idempotencyKey: `card_${VIAJE}_${VIAJE}`, payerId: `passenger_${VIAJE}`, cardToken: 'cnon:x' });

    expect(claves.length).toBeGreaterThanOrEqual(6);
    for (const { metodo, clave } of claves) {
      expect(clave.length, `${metodo} mandó «${clave}» (${clave.length})`).toBeLessThanOrEqual(LIMITE_REAL_DE_SQUARE);
      expect(clave, `${metodo} mandó una clave vacía`).not.toBe('');
    }
  });
});

describe('la clave acortada sigue haciendo su trabajo', () => {
  // La idempotencia ES esto: el mismo cobro, reintentado, tiene que llegar con la
  // MISMA clave, o Square lo cobra dos veces.
  it('UN REINTENTO MANDA LA MISMA CLAVE', async () => {
    const { cliente, claves } = squareEstricto();
    const p = new SquareProvider(cliente, OPCIONES);
    await p.authorize(COBRO);
    await p.authorize(COBRO);
    const creaciones = claves.filter((c) => c.metodo === 'payments.create');
    expect(creaciones).toHaveLength(2);
    expect(creaciones[0].clave).toBe(creaciones[1].clave);
  });

  it('operaciones distintas del mismo viaje NO comparten clave', async () => {
    const { cliente, claves } = squareEstricto();
    const p = new SquareProvider(cliente, OPCIONES);
    await p.authorize(COBRO);
    await p.capture({ idempotencyKey: `${CLAVE_DEL_COBRO}_capture`, providerRef: 'sqpmt_1', amount: 9000 });
    await p.refund({ idempotencyKey: `${CLAVE_DEL_COBRO}_refund`, providerRef: 'sqpmt_1', amount: 500 });
    const usadas = claves.map((c) => c.clave);
    expect(new Set(usadas).size).toBe(usadas.length);
  });

  // Ajustar a 9000 y ajustar a 8000 son dos operaciones, y el importe entra en la
  // clave: si el acortado lo perdiera, Square devolvería el primer ajuste al pedir
  // el segundo.
  it('AJUSTAR A OTRO IMPORTE ES OTRA CLAVE', async () => {
    const { cliente, claves } = squareEstricto();
    const p = new SquareProvider(cliente, OPCIONES);
    await p.capture({ idempotencyKey: `${CLAVE_DEL_COBRO}_capture`, providerRef: 'sqpmt_1', amount: 9000 });
    await p.capture({ idempotencyKey: `${CLAVE_DEL_COBRO}_capture`, providerRef: 'sqpmt_1', amount: 8000 });
    const ajustes = claves.filter((c) => c.metodo === 'payments.update').map((c) => c.clave);
    expect(ajustes).toHaveLength(2);
    expect(ajustes[0]).not.toBe(ajustes[1]);
  });

  it('dos viajes distintos no comparten clave aunque sólo cambie un carácter', async () => {
    const { cliente, claves } = squareEstricto();
    const p = new SquareProvider(cliente, OPCIONES);
    await p.authorize({ ...COBRO, idempotencyKey: `ride_${VIAJE}_authorize` });
    await p.authorize({ ...COBRO, idempotencyKey: `ride_${VIAJE.slice(0, -1)}c_authorize` });
    expect(claves[0].clave).not.toBe(claves[1].clave);
  });

  it('una clave que ya cabe viaja TAL CUAL: no se toca lo que no hace falta tocar', async () => {
    const { cliente, claves } = squareEstricto();
    await new SquareProvider(cliente, OPCIONES).authorize({ ...COBRO, idempotencyKey: 'ride_corta_authorize' });
    expect(claves[0].clave).toBe('ride_corta_authorize');
  });

  it('en la cabecera de completar y cancelar va la MISMA clave que en el cuerpo', async () => {
    const { cliente, cabeceras } = squareEstricto();
    const p = new SquareProvider(cliente, OPCIONES);
    const k = `${CLAVE_DEL_COBRO}_capture`;
    await p.capture({ idempotencyKey: k, providerRef: 'sqpmt_1' });
    await p.voidAuthorization({ idempotencyKey: `${CLAVE_DEL_COBRO}_void`, providerRef: 'sqpmt_1' });
    expect(cabeceras[0].clave).toBe(claveDeSquare(k));
    expect(cabeceras[1].clave).toBe(claveDeSquare(`${CLAVE_DEL_COBRO}_void`));
  });
});

describe('claveDeSquare', () => {
  it('el límite del adaptador es el de Square: 45', () => {
    expect(LIMITE_CLAVE_SQUARE).toBe(LIMITE_REAL_DE_SQUARE);
  });

  it('lo que cabe, no se toca; en el borde exacto tampoco', () => {
    expect(claveDeSquare('ride_corta')).toBe('ride_corta');
    const justa = 'x'.repeat(LIMITE_REAL_DE_SQUARE);
    expect(claveDeSquare(justa)).toBe(justa);
  });

  it('lo que no cabe se reduce a algo que sí, siempre', () => {
    for (const largo of [46, 51, 59, 77, 200, 1000]) {
      expect(claveDeSquare('k'.repeat(largo)).length).toBeLessThanOrEqual(LIMITE_REAL_DE_SQUARE);
    }
  });

  it('es determinista: la misma entrada, la misma salida', () => {
    expect(claveDeSquare(CLAVE_DEL_COBRO)).toBe(claveDeSquare(CLAVE_DEL_COBRO));
  });

  it('entradas distintas dan salidas distintas', () => {
    const salidas = new Set<string>();
    for (let i = 0; i < 2000; i++) salidas.add(claveDeSquare(`ride_${VIAJE}_authorize_${i}`));
    expect(salidas.size).toBe(2000);
  });

  // Lo que Square ve tiene que ser un texto cómodo de registrar y de pegar.
  it('sólo usa caracteres seguros', () => {
    expect(claveDeSquare(CLAVE_DEL_COBRO)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('marca lo acortado, para reconocerlo en el panel de Square', () => {
    expect(claveDeSquare(CLAVE_DEL_COBRO).startsWith('h1_')).toBe(true);
  });
});
