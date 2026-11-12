/**
 * El arranque de `SettingsService`: qué se escribe cuando el panel pide una
 * pasarela que esta tarea todavía no tiene montada.
 *
 * Pasa en CADA arranque cuando la pasarela por defecto del panel es una que sólo
 * existe con credenciales guardadas en la base (hoy, Square): `SettingsService`
 * arranca antes que `CredentialsService`, así que su primera lectura pide algo que
 * aún no está. Un instante después las credenciales montan la pasarela y llaman a
 * `aplicar()`, y ya funciona. Es un fallo transitorio y esperado, y se escribía como
 * ERROR: dos por despliegue, y cualquier alarma sobre errores saltaba en falso.
 */

import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config';
import { SettingsService } from './settings.service';
import { ProviderRegistry } from '../providers/provider.registry';
import type { PaymentProvider, ProviderName } from '../providers/provider.port';

const proveedor = (name: ProviderName) => ({ name, capabilities: { currencies: ['USD'] } }) as unknown as PaymentProvider;

/** Una base falsa que devuelve la fila de `payments.settings` que se le diga. */
function baseCon(pide: string | null) {
  return {
    query: vi.fn(async () => ({
      rows: pide === null ? [] : [{ value: { defaultProvider: pide }, updated_by: 'admin', updated_at: new Date('2026-11-12T20:00:00Z') }],
    })),
  };
}

function montar(pide: string | null, montados: ProviderName[] = ['stripe']) {
  const registry = new ProviderRegistry(montados.map(proveedor), 'stripe');
  const servicio = new SettingsService(baseCon(pide) as never, { PAYMENT_PROVIDER: 'stripe' } as Config, registry);
  return { servicio, registry };
}

describe('el panel pide una pasarela que todavía no está montada', () => {
  let aviso: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    aviso = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('EL PRIMER FALLO ES UN AVISO, NO UN ERROR: en el arranque la credencial se monta justo después', async () => {
    const { servicio } = montar('square');
    await servicio.aplicar();

    expect(error).not.toHaveBeenCalled();
    expect(aviso).toHaveBeenCalledTimes(1);
    expect(String(aviso.mock.calls[0][0])).toContain("pide 'square'");
    expect(String(aviso.mock.calls[0][0])).toContain("sigue 'stripe'");
  });

  it('con el arranque completo —falla, se monta, se aplica— NO SALE NINGÚN ERROR', async () => {
    const { servicio, registry } = montar('square');
    await servicio.aplicar();                 // SettingsService.onModuleInit: aún no está
    registry.montar(proveedor('square'));     // CredentialsService.onModuleInit: la monta…
    await servicio.aplicar();                 // …y vuelve a aplicar

    expect(registry.porDefecto).toBe('square');
    expect(error).not.toHaveBeenCalled();
  });

  // Si la pasarela NO llega a montarse —credencial rota, mal descifrada— eso sí es un
  // problema, y no puede quedarse como un aviso que nadie mira.
  it('SI SIGUE SIN MONTARSE EN LA SIGUIENTE LECTURA, YA ES UN ERROR', async () => {
    const { servicio, registry } = montar('square');
    await servicio.aplicar();
    expect(error).not.toHaveBeenCalled();

    await servicio.aplicar();                 // 30 s después, y sigue sin estar
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('2 intentos seguidos');
    expect(registry.porDefecto).toBe('stripe');

    await servicio.aplicar();
    expect(error).toHaveBeenCalledTimes(2);
    expect(String(error.mock.calls[1][0])).toContain('3 intentos seguidos');
  });

  it('un acierto reinicia la cuenta: el siguiente fallo vuelve a ser un aviso', async () => {
    const { servicio, registry } = montar('square');
    await servicio.aplicar();                 // fallo 1 (aviso)
    registry.montar(proveedor('square'));
    await servicio.aplicar();                 // acierta
    expect(registry.porDefecto).toBe('square');

    // El panel pide otra, que tampoco está montada: es un fallo NUEVO, no el tercero.
    (servicio as unknown as { pool: { query: unknown } }).pool.query = vi.fn(async () => ({
      rows: [{ value: { defaultProvider: 'adyen' }, updated_by: 'admin', updated_at: new Date() }],
    }));
    await servicio.aplicar();
    expect(error).not.toHaveBeenCalled();
  });

  it('la cuenta es por pasarela: pedir otra distinta no hereda los intentos de la primera', async () => {
    const { servicio } = montar('square');
    await servicio.aplicar();
    await servicio.aplicar();                 // 2.º seguido de 'square' → error
    expect(error).toHaveBeenCalledTimes(1);

    (servicio as unknown as { pool: { query: unknown } }).pool.query = vi.fn(async () => ({
      rows: [{ value: { defaultProvider: 'adyen' }, updated_by: 'admin', updated_at: new Date() }],
    }));
    await servicio.aplicar();                 // 1.º de 'adyen' → aviso
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(aviso.mock.calls.at(-1)![0])).toContain("pide 'adyen'");
  });
});

describe('lo que no cambia', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('si ya está montada, la pone por defecto sin escribir nada', async () => {
    const { servicio, registry } = montar('square', ['stripe', 'square']);
    await servicio.aplicar();
    expect(registry.porDefecto).toBe('square');
    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });

  it('sin fila guardada manda el entorno', async () => {
    const { servicio, registry } = montar(null);
    await servicio.aplicar();
    expect(registry.porDefecto).toBe('stripe');
    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });

  it('un nombre que no es un procesador se ignora con un aviso', async () => {
    const { servicio, registry } = montar('inventada');
    await servicio.aplicar();
    expect(registry.porDefecto).toBe('stripe');
    expect(Logger.prototype.warn).toHaveBeenCalled();
    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });

  it('si la base no responde, sigue lo último y avisa', async () => {
    const registry = new ProviderRegistry([proveedor('stripe')], 'stripe');
    const servicio = new SettingsService({ query: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) } as never, { PAYMENT_PROVIDER: 'stripe' } as Config, registry);
    await servicio.aplicar();
    expect(registry.porDefecto).toBe('stripe');
    expect(Logger.prototype.warn).toHaveBeenCalled();
  });
});
