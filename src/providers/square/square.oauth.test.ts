/**
 * La autorización OAuth de la cuenta de Square, que se hace UNA vez.
 *
 * El SDK móvil de Square no se autoriza con el token del servidor: necesita un token
 * OAuth con permisos de cobro, y ese se pide con el *refresh token* de la primera
 * autorización. Esa primera autorización es una persona abriendo una URL y
 * aceptando; esto es la parte que no depende de nadie y se puede probar.
 */

import { describe, expect, it } from 'vitest';
import { PERMISOS_DE_AUTORIZACION, urlDeAutorizacion, codigoDeLaRedireccion } from './square.oauth';

describe('urlDeAutorizacion', () => {
  const base = { applicationId: 'sq0idp-APP', environment: 'production' as const, state: 'estado-123' };

  it('apunta al host de producción o al de sandbox, según el entorno', () => {
    expect(urlDeAutorizacion(base)).toMatch(/^https:\/\/connect\.squareup\.com\/oauth2\/authorize\?/);
    expect(urlDeAutorizacion({ ...base, environment: 'sandbox' })).toMatch(/^https:\/\/connect\.squareupsandbox\.com\/oauth2\/authorize\?/);
  });

  it('lleva la aplicación, el estado y los permisos', () => {
    const u = new URL(urlDeAutorizacion(base));
    expect(u.searchParams.get('client_id')).toBe('sq0idp-APP');
    expect(u.searchParams.get('state')).toBe('estado-123');
    expect(u.searchParams.get('session')).toBe('false');
  });

  // Los permisos que se piden aquí son el TECHO de lo que el token del teléfono
  // podrá pedir después: `scopes` en ObtainToken sólo puede ser un subconjunto de
  // lo autorizado. Tienen que incluir los tres que usa el dispositivo.
  it('PIDE, COMO MÍNIMO, LOS TRES PERMISOS DEL TELÉFONO', () => {
    const pedidos = (new URL(urlDeAutorizacion(base)).searchParams.get('scope') ?? '').split(/[ +]/);
    for (const necesario of ['MERCHANT_PROFILE_READ', 'PAYMENTS_WRITE', 'PAYMENTS_WRITE_IN_PERSON']) {
      expect(pedidos, `falta ${necesario}`).toContain(necesario);
    }
  });

  it('no pide permisos de más: nada de empleados ni de comisiones a terceros', () => {
    for (const p of PERMISOS_DE_AUTORIZACION) {
      expect(p).not.toMatch(/EMPLOYEES|ADDITIONAL_RECIPIENTS|PAYOUTS|BANK|CUSTOMERS_WRITE/);
    }
  });

  it('con redirección, la lleva codificada', () => {
    const u = new URL(urlDeAutorizacion({ ...base, redirectUrl: 'https://payments.urbont.com/oauth/callback' }));
    expect(u.searchParams.get('redirect_uri')).toBe('https://payments.urbont.com/oauth/callback');
  });
});

describe('codigoDeLaRedireccion', () => {
  it('saca el código y el estado de la URL a la que Square redirige', () => {
    const r = codigoDeLaRedireccion('https://example.com/cb?code=sq0cgb-ABC&response_type=code&state=estado-123');
    expect(r).toEqual({ code: 'sq0cgb-ABC', state: 'estado-123' });
  });

  it('acepta también el código suelto, tal como se copia de la barra de direcciones', () => {
    expect(codigoDeLaRedireccion('sq0cgb-ABC')).toEqual({ code: 'sq0cgb-ABC', state: null });
  });

  it('una URL de error de Square se dice, no se confunde con un código', () => {
    expect(() => codigoDeLaRedireccion('https://example.com/cb?error=access_denied&error_description=el+vendedor+no+acepto'))
      .toThrow(/access_denied/);
  });

  it('una URL sin código es un error claro', () => {
    expect(() => codigoDeLaRedireccion('https://example.com/cb?state=x')).toThrow(/código/);
  });
});
