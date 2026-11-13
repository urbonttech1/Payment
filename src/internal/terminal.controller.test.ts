/**
 * El cobro en persona, probado por donde entra de verdad: por HTTP y firmado.
 *
 * Lo que cambia con Square es quién crea el pago: el teléfono, no el servidor. Por
 * eso aquí se prueba que la respuesta de `/charges` dice cuál de las dos formas es
 * (`flow`), que `/session` y `/charges` aceptan un proveedor preferido para que una
 * app ya publicada siga cobrando por Stripe, y que `/adopt` traduce bien cada
 * fallo: un pago que no es el esperado no puede salir como un error del servidor.
 */

import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG, type Config } from '../config/config';
import { POOL } from '../db/pool';
import { InternalModule } from './internal.module';
import { LedgerModule } from '../ledger/ledger.module';
import { SettingsModule } from '../config/settings.module';
import { PaymentsService, EstadoInesperadoError, TransaccionNoEncontradaError } from '../payments/payments.service';
import { SplitsService } from '../splits/splits.service';
import { PagoNoAdoptableError } from '../providers/provider.port';
import { cabecerasDeFirma } from './firma';

const SECRETO = 'secreto-compartido-de-prueba';
const RIDE = '11111111-1111-4111-8111-111111111111';
const PAX = '22222222-2222-4222-8222-222222222222';
const CLAVE = `tap_to_pay_${RIDE}_tok1abcd`;

const servicioFalso = {
  cobrarEnPersona: vi.fn(),
  sesionDeTerminal: vi.fn(),
  adoptarCobroPresencial: vi.fn(),
  autorizar: vi.fn(), capturar: vi.fn(), anular: vi.fn(), reembolsar: vi.fn(), porClave: vi.fn(),
};

@Global()
@Module({
  providers: [
    {
      provide: CONFIG,
      useValue: { SERVICE_SHARED_SECRET: SECRETO, PAYMENT_PROVIDER: 'stripe', PLATFORM_COMMISSION_RATE: 0.15 } as Config,
    },
    { provide: POOL, useValue: { query: async () => ({ rows: [], rowCount: 0 }) } },
  ],
  exports: [CONFIG, POOL],
})
class ConfigDePrueba {}

let app: INestApplication;
let base: string;

async function llamar(ruta: string, cuerpo: unknown = {}) {
  const texto = JSON.stringify(cuerpo);
  const r = await fetch(`${base}${ruta}`, {
    method: 'POST',
    headers: { ...cabecerasDeFirma({ metodo: 'POST', ruta, cuerpo: texto }, SECRETO), 'content-type': 'application/json' },
    body: texto,
  });
  return { estado: r.status, cuerpo: (await r.json().catch(() => null)) as Record<string, unknown> | null };
}

const PETICION = { chargeKey: CLAVE, kind: 'ride', amountCents: 3914, taxCents: 239, rideId: RIDE, payerId: PAX };

const filaPendiente = {
  id: 'tx-1', idempotencyKey: CLAVE, provider: 'square' as const, providerRef: null, kind: 'ride' as const,
  rideId: RIDE, payerId: PAX, amountCents: 3914, taxCents: 239, currency: 'USD' as const, status: 'pending' as const,
};

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [ConfigDePrueba, LedgerModule, SettingsModule, InternalModule] })
    .overrideProvider(PaymentsService).useValue(servicioFalso)
    .overrideProvider(SplitsService).useValue({ liquidar: vi.fn(), consultar: vi.fn() })
    .compile();
  app = mod.createNestApplication({ rawBody: true });
  await app.listen(0);
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});

afterAll(async () => { await app?.close(); });

beforeEach(() => {
  vi.clearAllMocks();
  servicioFalso.sesionDeTerminal.mockResolvedValue({
    provider: 'square', token: 'EAAAshort', locationRef: 'L1', applicationRef: 'sq0idp-APP', flow: 'device-sdk',
    expiresAt: new Date('2026-11-14T00:00:00Z'),
  });
  servicioFalso.cobrarEnPersona.mockResolvedValue({
    transaccion: filaPendiente,
    autorizacion: null,
    dispositivo: { referenceId: RIDE, paymentAttemptId: 'h1_intento' },
  });
  servicioFalso.adoptarCobroPresencial.mockResolvedValue({ ...filaPendiente, status: 'captured', providerRef: 'sqpmt_tap_1' });
});

describe('POST /internal/terminal/session', () => {
  it('con Square devuelve el token y TODO lo que el SDK del teléfono necesita para arrancar', async () => {
    const r = await llamar('/internal/terminal/session');
    expect(r.estado).toBe(200);
    expect(r.cuerpo).toEqual({
      provider: 'square', token: 'EAAAshort', locationRef: 'L1', applicationRef: 'sq0idp-APP',
      flow: 'device-sdk', expiresAt: '2026-11-14T00:00:00.000Z',
    });
  });

  it('un proveedor preferido llega al servicio (una app vieja pide Stripe)', async () => {
    await llamar('/internal/terminal/session', { provider: 'stripe' });
    expect(servicioFalso.sesionDeTerminal).toHaveBeenCalledWith('stripe');
  });

  it('sin cuerpo, sin preferencia: el servicio elige', async () => {
    await llamar('/internal/terminal/session');
    expect(servicioFalso.sesionDeTerminal).toHaveBeenCalledWith(undefined);
  });

  it('un proveedor que no existe se rechaza como petición mala, no se pasa al servicio', async () => {
    const r = await llamar('/internal/terminal/session', { provider: 'inventado' });
    expect(r.estado).toBe(400);
    expect(servicioFalso.sesionDeTerminal).not.toHaveBeenCalled();
  });
});

describe('POST /internal/terminal/charges', () => {
  it('con Square dice que cobra el teléfono: sin clientSecret, con la referencia y el intento para el SDK', async () => {
    const r = await llamar('/internal/terminal/charges', PETICION);
    expect(r.estado).toBe(200);
    expect(r.cuerpo).toMatchObject({
      chargeKey: CLAVE, status: 'pending', provider: 'square', providerRef: null,
      flow: 'device-sdk', referenceId: RIDE, paymentAttemptId: 'h1_intento', amountCents: 3914,
    });
    expect(r.cuerpo).not.toHaveProperty('clientSecret');
  });

  it('con Stripe sigue como antes: clientSecret y flujo server-intent', async () => {
    servicioFalso.cobrarEnPersona.mockResolvedValue({
      transaccion: { ...filaPendiente, provider: 'stripe', providerRef: 'pi_1' },
      autorizacion: { clientSecret: 'pi_1_secret' },
    });
    const r = await llamar('/internal/terminal/charges', PETICION);
    expect(r.cuerpo).toMatchObject({ provider: 'stripe', providerRef: 'pi_1', clientSecret: 'pi_1_secret', flow: 'server-intent' });
    expect(r.cuerpo).not.toHaveProperty('referenceId');
  });

  it('el proveedor preferido viaja al servicio como `proveedor`', async () => {
    await llamar('/internal/terminal/charges', { ...PETICION, provider: 'stripe' });
    expect(servicioFalso.cobrarEnPersona.mock.calls[0][0]).toMatchObject({ proveedor: 'stripe', idempotencyKey: CLAVE, hold: false });
  });

  it('un proveedor inventado es una petición mala', async () => {
    const r = await llamar('/internal/terminal/charges', { ...PETICION, provider: 'inventado' });
    expect(r.estado).toBe(400);
    expect(servicioFalso.cobrarEnPersona).not.toHaveBeenCalled();
  });
});

describe('POST /internal/terminal/charges/:clave/adopt', () => {
  const ruta = `/internal/terminal/charges/${CLAVE}/adopt`;

  it('adopta el pago y devuelve el cobro capturado', async () => {
    const r = await llamar(ruta, { providerRef: 'sqpmt_tap_1' });
    expect(r.estado).toBe(200);
    expect(r.cuerpo).toMatchObject({ chargeKey: CLAVE, status: 'captured', provider: 'square', providerRef: 'sqpmt_tap_1', amountCents: 3914 });
  });

  // `urbont-api` guarda el impuesto en el viaje al dar el cobro por bueno, y no
  // tiene otra fuente que esta respuesta: sin él habría que volver a calcularlo.
  it('devuelve también el impuesto del cobro', async () => {
    const r = await llamar(ruta, { providerRef: 'sqpmt_tap_1' });
    expect(r.cuerpo).toMatchObject({ taxCents: 239 });
    expect(servicioFalso.adoptarCobroPresencial).toHaveBeenCalledWith(CLAVE, 'sqpmt_tap_1');
  });

  it('sin el id del pago, es una petición mala', async () => {
    const r = await llamar(ruta, {});
    expect(r.estado).toBe(400);
    expect(servicioFalso.adoptarCobroPresencial).not.toHaveBeenCalled();
  });

  it('UN PAGO QUE NO ES EL ESPERADO es un 422 con el motivo, no un error del servidor', async () => {
    servicioFalso.adoptarCobroPresencial.mockRejectedValue(
      new PagoNoAdoptableError('square', 'importe', 'se cobraron 100 y se esperaban 3914'),
    );
    const r = await llamar(ruta, { providerRef: 'sqpmt_tap_1' });
    expect(r.estado).toBe(422);
    expect(r.cuerpo).toMatchObject({ error: 'PAYMENT_NOT_ADOPTABLE', motivo: 'importe' });
  });

  it('un cobro que no existe es un 404', async () => {
    servicioFalso.adoptarCobroPresencial.mockRejectedValue(new TransaccionNoEncontradaError(CLAVE));
    expect((await llamar(ruta, { providerRef: 'sqpmt_tap_1' })).estado).toBe(404);
  });

  it('un pago ya usado por otro cobro es un 409', async () => {
    servicioFalso.adoptarCobroPresencial.mockRejectedValue(new EstadoInesperadoError('ya adoptado'));
    expect((await llamar(ruta, { providerRef: 'sqpmt_tap_1' })).estado).toBe(409);
  });
});
