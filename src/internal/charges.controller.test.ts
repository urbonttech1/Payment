/**
 * La puerta, probada por donde entra de verdad: por HTTP.
 *
 * Levanta el servicio en un puerto libre y le habla con `fetch`, firmando como
 * firma `urbont-api`. Probar el controlador llamando a sus métodos a mano no
 * valdría para esto: el guardia trabaja sobre el **cuerpo crudo**, y el cuerpo
 * crudo sólo existe si la petición ha pasado por el servidor.
 */

import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG, type Config } from '../config/config';
import { InternalModule } from './internal.module';
import { PaymentsService, EstadoInesperadoError, TransaccionNoEncontradaError } from '../payments/payments.service';
import { PagoRechazadoError, ProcesadorFalloError } from '../providers/provider.port';
import { cabecerasDeFirma } from './firma';

const SECRETO = 'secreto-compartido-de-prueba';
const CLAVE = 'ride_abc-123_authorize';

const transaccion = {
  id: 'tx-1',
  idempotencyKey: CLAVE,
  provider: 'stripe' as const,
  providerRef: 'pi_123',
  kind: 'ride' as const,
  rideId: 'abc-123',
  payerId: 'pax-1',
  amountCents: 11000,
  taxCents: 715,
  currency: 'USD' as const,
  status: 'authorized' as const,
  authorizedAt: new Date('2026-11-06T12:00:00Z'),
  capturedAt: null,
  failedAt: null,
  failureCode: null,
  createdAt: new Date('2026-11-06T12:00:00Z'),
};

const servicioFalso = {
  autorizar: vi.fn(),
  capturar: vi.fn(),
  anular: vi.fn(),
  reembolsar: vi.fn(),
  porClave: vi.fn(),
};

@Global()
@Module({
  providers: [{ provide: CONFIG, useValue: { SERVICE_SHARED_SECRET: SECRETO } as Config }],
  exports: [CONFIG],
})
class ConfigDePrueba {}

let app: INestApplication;
let base: string;

/** Llama como llamaría `urbont-api`: firmado. */
async function llamar(
  metodo: 'GET' | 'POST',
  ruta: string,
  opciones: { cuerpo?: unknown; clave?: string; ts?: number; firmarComo?: string; secreto?: string } = {},
) {
  const cuerpo = opciones.cuerpo === undefined ? '' : JSON.stringify(opciones.cuerpo);
  const cabeceras: Record<string, string> = {
    ...cabecerasDeFirma(
      { metodo, ruta: opciones.firmarComo ?? ruta, cuerpo, ts: opciones.ts },
      opciones.secreto ?? SECRETO,
    ),
    ...(opciones.clave ? { 'idempotency-key': opciones.clave } : {}),
    ...(cuerpo ? { 'content-type': 'application/json' } : {}),
  };
  const r = await fetch(`${base}${ruta}`, {
    method: metodo,
    headers: cabeceras,
    ...(cuerpo ? { body: cuerpo } : {}),
  });
  return { estado: r.status, cuerpo: (await r.json().catch(() => null)) as Record<string, unknown> | null };
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [ConfigDePrueba, InternalModule] })
    .overrideProvider(PaymentsService)
    .useValue(servicioFalso)
    .compile();

  app = mod.createNestApplication({ rawBody: true });
  await app.listen(0);
  const dir = app.getHttpServer().address() as AddressInfo;
  base = `http://127.0.0.1:${dir.port}`;
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  servicioFalso.autorizar.mockResolvedValue({ transaccion, autorizacion: { clientSecret: 'pi_123_secret_x' } });
  servicioFalso.capturar.mockResolvedValue({ ...transaccion, status: 'captured', amountCents: 12000 });
  servicioFalso.anular.mockResolvedValue({ ...transaccion, status: 'voided' });
  servicioFalso.reembolsar.mockResolvedValue({
    transaccion: { ...transaccion, status: 'refunded' },
    reembolso: { providerRef: 're_1', provider: 'stripe', refunded: 11000, currency: 'USD' },
  });
  servicioFalso.porClave.mockResolvedValue(transaccion);
});

const cobro = { kind: 'ride', amountCents: 11000, taxCents: 715, currency: 'USD', hold: true, rideId: 'abc-123' };

describe('la firma es la cerradura', () => {
  it('sin firma no se entra', async () => {
    const r = await fetch(`${base}/internal/charges/${CLAVE}`);
    expect(r.status).toBe(401);
    expect(servicioFalso.porClave).not.toHaveBeenCalled();
  });

  it('con otro secreto no se entra', async () => {
    const r = await llamar('GET', `/internal/charges/${CLAVE}`, { secreto: 'un-secreto-que-no-es' });
    expect(r.estado).toBe(401);
  });

  it('una firma de hace una hora no se entra', async () => {
    const r = await llamar('GET', `/internal/charges/${CLAVE}`, { ts: Date.now() - 3_600_000 });
    expect(r.estado).toBe(401);
  });

  it('firmar un cuerpo y mandar otro no se entra', async () => {
    const cuerpo = JSON.stringify({ ...cobro, amountCents: 100 });
    const r = await fetch(`${base}/internal/charges`, {
      method: 'POST',
      headers: {
        ...cabecerasDeFirma({ metodo: 'POST', ruta: '/internal/charges', cuerpo: JSON.stringify(cobro) }, SECRETO),
        'idempotency-key': CLAVE,
        'content-type': 'application/json',
      },
      body: cuerpo,
    });
    expect(r.status).toBe(401);
    expect(servicioFalso.autorizar).not.toHaveBeenCalled();
  });

  it('la firma de capturar no sirve para reembolsar', async () => {
    const r = await llamar('POST', `/internal/charges/${CLAVE}/refund`, {
      cuerpo: {},
      firmarComo: `/internal/charges/${CLAVE}/capture`,
    });
    expect(r.estado).toBe(401);
    expect(servicioFalso.reembolsar).not.toHaveBeenCalled();
  });

  it('el 401 no dice por qué', async () => {
    const r = await llamar('GET', `/internal/charges/${CLAVE}`, { secreto: 'otro-secreto-cualquiera' });
    expect(JSON.stringify(r.cuerpo)).not.toMatch(/firma|desvío|secreto/i);
  });
});

describe('autorizar', () => {
  it('cobra con la clave de la cabecera y devuelve el clientSecret', async () => {
    const r = await llamar('POST', '/internal/charges', { cuerpo: cobro, clave: CLAVE });

    expect(r.estado).toBe(200);
    expect(servicioFalso.autorizar).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: CLAVE, amountCents: 11000, hold: true, rideId: 'abc-123' }),
    );
    expect(r.cuerpo).toMatchObject({
      chargeKey: CLAVE,
      status: 'authorized',
      provider: 'stripe',
      providerRef: 'pi_123',
      clientSecret: 'pi_123_secret_x',
    });
  });

  it('la traza del que llama viaja al cobro', async () => {
    await llamar('POST', '/internal/charges', {
      cuerpo: { ...cobro, metadata: { commission_rate: '0.15', tax_calculation_id: 'taxcalc_1' } },
      clave: CLAVE,
    });
    expect(servicioFalso.autorizar).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { commission_rate: '0.15', tax_calculation_id: 'taxcalc_1' } }),
    );
  });

  it('sin clave de idempotencia no se cobra', async () => {
    const r = await llamar('POST', '/internal/charges', { cuerpo: cobro });
    expect(r.estado).toBe(400);
    expect(servicioFalso.autorizar).not.toHaveBeenCalled();
  });

  it('un importe imposible no se cobra', async () => {
    for (const amountCents of [0, -500, 1.5]) {
      const r = await llamar('POST', '/internal/charges', { cuerpo: { ...cobro, amountCents }, clave: CLAVE });
      expect(r.estado).toBe(400);
    }
    expect(servicioFalso.autorizar).not.toHaveBeenCalled();
  });
});

describe('capturar, anular, reembolsar y consultar', () => {
  it('captura el importe que le dan', async () => {
    const r = await llamar('POST', `/internal/charges/${CLAVE}/capture`, { cuerpo: { amountCents: 12000 } });
    expect(r.estado).toBe(200);
    expect(servicioFalso.capturar).toHaveBeenCalledWith(CLAVE, 12000);
    expect(r.cuerpo).toMatchObject({ status: 'captured', amountCents: 12000 });
  });

  it('captura sin importe captura lo autorizado', async () => {
    await llamar('POST', `/internal/charges/${CLAVE}/capture`, { cuerpo: {} });
    expect(servicioFalso.capturar).toHaveBeenCalledWith(CLAVE, undefined);
  });

  it('anula', async () => {
    const r = await llamar('POST', `/internal/charges/${CLAVE}/void`, { cuerpo: {} });
    expect(r.estado).toBe(200);
    expect(r.cuerpo).toMatchObject({ status: 'voided' });
  });

  it('reembolsa y dice cuánto', async () => {
    const r = await llamar('POST', `/internal/charges/${CLAVE}/refund`, {
      cuerpo: { amountCents: 11000, reason: 'requested_by_customer' },
    });
    expect(r.estado).toBe(200);
    expect(r.cuerpo).toMatchObject({ status: 'refunded', refund: { refundedCents: 11000 } });
  });

  it('consultar un cobro que existe lo devuelve', async () => {
    const r = await llamar('GET', `/internal/charges/${CLAVE}`);
    expect(r.estado).toBe(200);
    expect(r.cuerpo).toMatchObject({ chargeKey: CLAVE, providerRef: 'pi_123' });
  });

  it('consultar un cobro que no existe es 404, que es la señal de «no es mío»', async () => {
    servicioFalso.porClave.mockResolvedValueOnce(null);
    const r = await llamar('GET', `/internal/charges/${CLAVE}`);
    expect(r.estado).toBe(404);
    expect(r.cuerpo).toMatchObject({ error: 'CHARGE_NOT_FOUND' });
  });
});

describe('los códigos con los que el otro lado decide', () => {
  it('cobro desconocido → 404', async () => {
    servicioFalso.capturar.mockRejectedValueOnce(new TransaccionNoEncontradaError(CLAVE));
    const r = await llamar('POST', `/internal/charges/${CLAVE}/capture`, { cuerpo: {} });
    expect(r.estado).toBe(404);
    expect(r.cuerpo).toMatchObject({ error: 'CHARGE_NOT_FOUND' });
  });

  it('estado que no admite la operación → 409', async () => {
    servicioFalso.capturar.mockRejectedValueOnce(new EstadoInesperadoError("no se puede capturar 'voided'"));
    const r = await llamar('POST', `/internal/charges/${CLAVE}/capture`, { cuerpo: {} });
    expect(r.estado).toBe(409);
    expect(r.cuerpo).toMatchObject({ error: 'UNEXPECTED_CHARGE_STATE' });
  });

  it('tarjeta rechazada → 402 con el código, para que nadie reintente', async () => {
    servicioFalso.capturar.mockRejectedValueOnce(
      new PagoRechazadoError('card_declined', 'Your card was declined.', 'stripe'),
    );
    const r = await llamar('POST', `/internal/charges/${CLAVE}/capture`, { cuerpo: {} });
    expect(r.estado).toBe(402);
    expect(r.cuerpo).toMatchObject({ error: 'PAYMENT_DECLINED', code: 'card_declined' });
  });

  it('el procesador falló → 502, que sí se puede reintentar', async () => {
    servicioFalso.autorizar.mockRejectedValueOnce(new ProcesadorFalloError('stripe', 'Stripe falló: 500'));
    const r = await llamar('POST', '/internal/charges', { cuerpo: cobro, clave: CLAVE });
    expect(r.estado).toBe(502);
    expect(r.cuerpo).toMatchObject({ error: 'PROVIDER_FAILED' });
  });

  it('un error inesperado → 500 y sin filtrar nada', async () => {
    servicioFalso.autorizar.mockRejectedValueOnce(new Error('se cayó el pool con la contraseña en el mensaje'));
    const r = await llamar('POST', '/internal/charges', { cuerpo: cobro, clave: CLAVE });
    expect(r.estado).toBe(500);
    expect(r.cuerpo).toEqual({ error: 'INTERNAL' });
  });
});
