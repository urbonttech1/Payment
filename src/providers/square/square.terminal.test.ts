/**
 * Square y el cobro en persona.
 *
 * Con Stripe, el servidor crea el cobro y el teléfono lo confirma con un
 * `clientSecret`. Con Square es al revés: el SDK del teléfono CREA el pago por sí
 * mismo, y el servidor solo puede **adoptarlo** —leerlo, comprobar que es el que
 * se esperaba y apuntarlo en el libro—. Estas pruebas fijan las dos mitades que
 * eso exige: el token que arranca el SDK, y las comprobaciones antes de adoptar.
 *
 * La segunda es la que importa. El importe lo calcula el servidor, pero lo cobra
 * un teléfono: si adoptar no comprobara nada, un dispositivo manipulado podría
 * cobrar menos —o cobrar otra cosa— y el libro lo daría por bueno.
 */

import { describe, expect, it, vi } from 'vitest';
import { SquareError } from 'square';
import type { SquareClient } from 'square';
import { PagoNoAdoptableError, ProcesadorFalloError } from '../provider.port';
import { SquareProvider } from './square.provider';
import { LIMITE_CLAVE_SQUARE } from './square.mapper';

const OPCIONES = { locationId: 'L1' };

const RIDE = '11111111-1111-4111-8111-111111111111';

/** El pago tal como lo deja el SDK del teléfono: completo, en nuestra location, con el viaje por referencia. */
const PAGO = {
  id: 'sqpmt_tap_1',
  status: 'COMPLETED',
  locationId: 'L1',
  referenceId: RIDE,
  amountMoney: { amount: 3914n, currency: 'USD' },
  totalMoney: { amount: 3914n, currency: 'USD' },
};

const ESPERADO = { amount: 3914, currency: 'USD' as const, reference: RIDE };

function oauthFalso(respuesta: unknown = { accessToken: 'EAAAshort', expiresAt: '2026-11-14T00:00:00Z' }, fallo?: Error) {
  const obtainToken = vi.fn(async () => {
    if (fallo) throw fallo;
    return respuesta;
  });
  return {
    obtainToken,
    config: {
      applicationId: 'sq0idp-APP',
      applicationSecret: 'sq0csp-SECRETO',
      refreshToken: 'EQAAREFRESH',
      client: { oAuth: { obtainToken } } as unknown as SquareClient,
    },
  };
}

function squareConPago(pago: unknown) {
  return { payments: { get: vi.fn(async () => ({ payment: pago })) } } as unknown as SquareClient;
}

describe('sin credenciales OAuth: Square no anuncia el cobro presencial', () => {
  it('tapToPay es false y no hay ni sesión ni adopción (la suite de conformidad lo exige)', () => {
    const p = new SquareProvider(squareConPago(PAGO), OPCIONES);
    expect(p.capabilities.tapToPay).toBe(false);
    expect(p.terminalSession).toBeUndefined();
    expect(p.adoptPayment).toBeUndefined();
    expect(p.presentCharge).toBeUndefined();
  });
});

describe('con credenciales OAuth: el interruptor de Tap to Pay', () => {
  it('declara tapToPay y tiene la sesión y la adopción, pero NO presentCharge (el cobro lo crea el teléfono)', () => {
    const p = new SquareProvider(squareConPago(PAGO), OPCIONES, oauthFalso().config);
    expect(p.capabilities.tapToPay).toBe(true);
    expect(typeof p.terminalSession).toBe('function');
    expect(typeof p.adoptPayment).toBe('function');
    expect(p.presentCharge).toBeUndefined();
  });
});

describe('terminalSession: el token que arranca el SDK del teléfono', () => {
  it('pide un token CORTO (24 h) con los tres permisos justos y ni uno más', async () => {
    const o = oauthFalso();
    const p = new SquareProvider(squareConPago(PAGO), OPCIONES, o.config);
    await p.terminalSession!();

    expect(o.obtainToken).toHaveBeenCalledTimes(1);
    const peticion = (o.obtainToken.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(peticion).toMatchObject({
      clientId: 'sq0idp-APP',
      clientSecret: 'sq0csp-SECRETO',
      grantType: 'refresh_token',
      refreshToken: 'EQAAREFRESH',
      shortLived: true,
    });
    // Sin PAYMENTS_WRITE_ADDITIONAL_RECIPIENTS, EMPLOYEES_READ ni nada de lectura: un
    // token que vive en el teléfono de un chofer no lleva permisos que no usa.
    expect([...(peticion.scopes as string[])].sort()).toEqual(
      ['MERCHANT_PROFILE_READ', 'PAYMENTS_WRITE', 'PAYMENTS_WRITE_IN_PERSON'],
    );
  });

  it('devuelve lo que el SDK necesita: token, location, application id y que el cobro lo hace el teléfono', async () => {
    const p = new SquareProvider(squareConPago(PAGO), OPCIONES, oauthFalso().config);
    const s = await p.terminalSession!();

    expect(s).toMatchObject({
      provider: 'square',
      token: 'EAAAshort',
      locationRef: 'L1',
      applicationRef: 'sq0idp-APP',
      flow: 'device-sdk',
    });
    expect(s.expiresAt).toEqual(new Date('2026-11-14T00:00:00Z'));
  });

  it('el token del dispositivo NO es el del servidor: se pide uno nuevo en cada sesión', async () => {
    const o = oauthFalso();
    const p = new SquareProvider(squareConPago(PAGO), OPCIONES, o.config);
    await p.terminalSession!();
    await p.terminalSession!();
    expect(o.obtainToken).toHaveBeenCalledTimes(2);
  });

  it('si Square no contesta, es un fallo del procesador (se cae al camino de siempre)', async () => {
    const caido = new SquareError({
      message: 'caído', statusCode: 500,
      body: { errors: [{ category: 'API_ERROR', code: 'INTERNAL_SERVER_ERROR', detail: 'Algo falló.' }] },
    });
    const p = new SquareProvider(squareConPago(PAGO), OPCIONES, oauthFalso(undefined, caido).config);
    await expect(p.terminalSession!()).rejects.toBeInstanceOf(ProcesadorFalloError);
  });

  it('una respuesta sin token no se entrega al teléfono como si fuera buena', async () => {
    const p = new SquareProvider(squareConPago(PAGO), OPCIONES, oauthFalso({ expiresAt: 'x' }).config);
    await expect(p.terminalSession!()).rejects.toBeInstanceOf(ProcesadorFalloError);
  });
});

describe('deviceAttemptKey: la clave que el teléfono usa para no cobrar dos veces', () => {
  it('cabe en el límite de Square (45) aunque la clave de urbont mida más, y es determinista', () => {
    const p = new SquareProvider(squareConPago(PAGO), OPCIONES, oauthFalso().config);
    const larga = `tap_to_pay_${RIDE}_${'a'.repeat(36)}`;
    expect(larga.length).toBeGreaterThan(LIMITE_CLAVE_SQUARE);

    const a = p.deviceAttemptKey!(larga);
    expect(a.length).toBeLessThanOrEqual(LIMITE_CLAVE_SQUARE);
    expect(p.deviceAttemptKey!(larga)).toBe(a);
    expect(p.deviceAttemptKey!(`${larga}x`)).not.toBe(a);
  });
});

describe('adoptPayment: lo que se comprueba ANTES de dar un pago por bueno', () => {
  const adoptar = (pago: unknown, esperado: Parameters<NonNullable<SquareProvider['adoptPayment']>>[0]['expected'] = ESPERADO) =>
    new SquareProvider(squareConPago(pago), OPCIONES, oauthFalso().config).adoptPayment!({
      providerRef: 'sqpmt_tap_1',
      expected: esperado,
    });

  it('un pago completo, en nuestra location, del importe y del viaje esperados: se adopta como capturado', async () => {
    const a = await adoptar(PAGO);
    expect(a).toMatchObject({
      provider: 'square',
      providerRef: 'sqpmt_tap_1',
      status: 'captured',
      amount: 3914,
      currency: 'USD',
      chargeRef: 'sqpmt_tap_1',
    });
  });

  it('lee el pago de Square por su id: no se fía de lo que diga el teléfono', async () => {
    const cliente = squareConPago(PAGO);
    await new SquareProvider(cliente, OPCIONES, oauthFalso().config).adoptPayment!({ providerRef: 'sqpmt_tap_1', expected: ESPERADO });
    expect((cliente.payments.get as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({ paymentId: 'sqpmt_tap_1' });
  });

  it('IMPORTE DISTINTO: no se adopta (un teléfono manipulado no puede cobrar menos)', async () => {
    const menos = { ...PAGO, amountMoney: { amount: 100n, currency: 'USD' }, totalMoney: { amount: 100n, currency: 'USD' } };
    await expect(adoptar(menos)).rejects.toMatchObject({ name: 'PagoNoAdoptableError', motivo: 'importe' });
  });

  it('MONEDA DISTINTA: no se adopta', async () => {
    const otra = { ...PAGO, amountMoney: { amount: 3914n, currency: 'CAD' } };
    await expect(adoptar(otra)).rejects.toMatchObject({ motivo: 'moneda' });
  });

  it('OTRA LOCATION: no se adopta (un pago de otro uso de la cuenta no es de este viaje)', async () => {
    await expect(adoptar({ ...PAGO, locationId: 'L2' })).rejects.toMatchObject({ motivo: 'location' });
  });

  it('OTRO VIAJE en la referencia: no se adopta (el mismo pago no se puede colgar de dos viajes)', async () => {
    await expect(adoptar({ ...PAGO, referenceId: 'otro-viaje' })).rejects.toMatchObject({ motivo: 'referencia' });
  });

  it('un pago sin referencia, cuando se esperaba una, tampoco', async () => {
    await expect(adoptar({ ...PAGO, referenceId: undefined })).rejects.toMatchObject({ motivo: 'referencia' });
  });

  it('PROPINA puesta en el teléfono: no se adopta, porque el total ya no cuadra con el libro', async () => {
    const conPropina = { ...PAGO, tipMoney: { amount: 500n, currency: 'USD' }, totalMoney: { amount: 4414n, currency: 'USD' } };
    await expect(adoptar(conPropina)).rejects.toMatchObject({ motivo: 'propina' });
  });

  it('un pago que no ha terminado (APPROVED, FAILED, CANCELED…) no se adopta como cobrado', async () => {
    for (const status of ['APPROVED', 'PENDING', 'FAILED', 'CANCELED']) {
      await expect(adoptar({ ...PAGO, status })).rejects.toMatchObject({ motivo: 'estado' });
    }
  });

  it('si Square no tiene ese pago, tampoco se adopta', async () => {
    await expect(adoptar(undefined)).rejects.toBeInstanceOf(PagoNoAdoptableError);
  });

  it('sin referencia esperada (un cobro sin viaje) no se exige referencia', async () => {
    const a = await adoptar({ ...PAGO, referenceId: undefined }, { amount: 3914, currency: 'USD' });
    expect(a.status).toBe('captured');
  });

  it('el motivo del rechazo dice qué no cuadró, para poder leerlo en el registro', async () => {
    const e = await adoptar({ ...PAGO, locationId: 'L9' }).catch((x: unknown) => x as Error);
    expect(e.message).toContain('location');
  });
});
