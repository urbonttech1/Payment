import { describe, it, expect } from 'vitest';
import { opcionesSsl } from './pool';

describe('opcionesSsl', () => {
  it('cifra por defecto, sin verificar el certificado (Supabase)', () => {
    expect(opcionesSsl('postgres://u:p@db.supabase.co:5432/urbont')).toEqual({ rejectUnauthorized: false });
  });

  it('respeta sslmode=disable, para un Postgres de desarrollo', () => {
    expect(opcionesSsl('postgres://u:p@host.docker.internal:5432/urbont?sslmode=disable')).toBeUndefined();
  });

  it('verifica el certificado cuando se pide explícitamente', () => {
    expect(opcionesSsl('postgres://u:p@h:5432/d?sslmode=verify-full')).toEqual({ rejectUnauthorized: true });
    expect(opcionesSsl('postgres://u:p@h:5432/d?sslmode=verify-ca')).toEqual({ rejectUnauthorized: true });
  });

  it('encuentra sslmode aunque no sea el primer parámetro', () => {
    expect(opcionesSsl('postgres://u:p@h:5432/d?application_name=pagos&sslmode=disable')).toBeUndefined();
  });

  it('ante un sslmode que no conoce, cifra', () => {
    expect(opcionesSsl('postgres://u:p@h:5432/d?sslmode=prefer')).toEqual({ rejectUnauthorized: false });
  });
});
