import { describe, it, expect } from 'vitest';
import { cargarConfig } from './config';

const minimo = {
  DATABASE_URL: 'postgres://user:pass@host:5432/db',
  SERVICE_SHARED_SECRET: 'un-secreto-bastante-largo',
};

describe('cargarConfig', () => {
  it('acepta lo mínimo y rellena los valores por defecto', () => {
    const c = cargarConfig(minimo as NodeJS.ProcessEnv);
    expect(c.PORT).toBe(8080);
    expect(c.PAYMENT_PROVIDER).toBe('stripe');
    expect(c.NODE_ENV).toBe('development');
    expect(c.PAYMENTS_PUBLIC_URL).toBe('https://payments.urbont.com');
  });

  it('una dirección pública vacía cuenta como la de producción', () => {
    const c = cargarConfig({ ...minimo, PAYMENTS_PUBLIC_URL: '' } as NodeJS.ProcessEnv);
    expect(c.PAYMENTS_PUBLIC_URL).toBe('https://payments.urbont.com');
  });

  it('no arranca sin base de datos', () => {
    expect(() => cargarConfig({ SERVICE_SHARED_SECRET: minimo.SERVICE_SHARED_SECRET } as NodeJS.ProcessEnv))
      .toThrow(/DATABASE_URL/);
  });

  it('no acepta un secreto corto entre servicios', () => {
    expect(() => cargarConfig({ ...minimo, SERVICE_SHARED_SECRET: 'corto' } as NodeJS.ProcessEnv))
      .toThrow(/SERVICE_SHARED_SECRET/);
  });

  it('rechaza un procesador que no existe', () => {
    expect(() => cargarConfig({ ...minimo, PAYMENT_PROVIDER: 'bizum' } as unknown as NodeJS.ProcessEnv))
      .toThrow(/PAYMENT_PROVIDER/);
  });
})
