/**
 * Montar (o no montar) Square.
 *
 * Importa porque el fallo silencioso aquí es caro: un token sin localización
 * monta un adaptador que rechaza cada cobro, y el panel ofrecería Square como
 * pasarela disponible. Mejor no montarlo y decirlo en el arranque.
 */

import { describe, expect, it } from 'vitest';
import { crearSquareProvider } from './square.module';

const BASE = {
  SQUARE_ACCESS_TOKEN: undefined,
  SQUARE_LOCATION_ID: undefined,
  SQUARE_ENVIRONMENT: 'production' as const,
  SQUARE_WEBHOOK_SIGNATURE_KEY: undefined,
  SQUARE_WEBHOOK_NOTIFICATION_URL: undefined,
};

describe('crearSquareProvider', () => {
  it('sin credenciales no se monta, y el servicio arranca igual', () => {
    expect(crearSquareProvider(BASE)).toBeNull();
  });

  // Square exige la localización en cada cobro: un token suelto montaría una
  // pasarela que no puede cobrar nada.
  it('UN TOKEN SIN LOCALIZACIÓN NO BASTA', () => {
    expect(crearSquareProvider({ ...BASE, SQUARE_ACCESS_TOKEN: 'EAAA_token' })).toBeNull();
    expect(crearSquareProvider({ ...BASE, SQUARE_LOCATION_ID: 'L1' })).toBeNull();
  });

  it('con las dos, se monta y se llama square', () => {
    const p = crearSquareProvider({ ...BASE, SQUARE_ACCESS_TOKEN: 'EAAA_token', SQUARE_LOCATION_ID: 'L1' });
    expect(p?.name).toBe('square');
    expect(p?.capabilities.currencies).toContain('USD');
  });
});

describe('Tap to Pay: el interruptor son las credenciales de OAuth', () => {
  const MONTADO = { ...BASE, SQUARE_ACCESS_TOKEN: 'EAAA_token', SQUARE_LOCATION_ID: 'L1' };
  const OAUTH = {
    SQUARE_APPLICATION_ID: 'sq0idp-APP',
    SQUARE_APPLICATION_SECRET: 'sq0csp-SECRETO',
    SQUARE_REFRESH_TOKEN: 'EQAAREFRESH',
  };

  it('sin OAuth, Square se monta igual pero NO anuncia Tap to Pay', () => {
    const p = crearSquareProvider({ ...MONTADO, SQUARE_APPLICATION_ID: undefined, SQUARE_APPLICATION_SECRET: undefined, SQUARE_REFRESH_TOKEN: undefined });
    expect(p?.capabilities.tapToPay).toBe(false);
    expect(p?.terminalSession).toBeUndefined();
  });

  it('con los tres, anuncia Tap to Pay y tiene sesión y adopción', () => {
    const p = crearSquareProvider({ ...MONTADO, ...OAUTH });
    expect(p?.capabilities.tapToPay).toBe(true);
    expect(typeof p?.terminalSession).toBe('function');
    expect(typeof p?.adoptPayment).toBe('function');
  });

  // Dos de tres no sirven: sin el secreto o sin el refresh token no se puede
  // pedir el token del teléfono, y anunciar Tap to Pay haría que el registro lo
  // eligiera para un cobro que acabaría fallando con el chofer delante.
  it('CON UNO O DOS DE LOS TRES, NO: todo o nada', () => {
    for (const falta of Object.keys(OAUTH)) {
      const parcial = { ...OAUTH, [falta]: undefined };
      const p = crearSquareProvider({ ...MONTADO, ...parcial });
      expect(p?.capabilities.tapToPay, `sin ${falta}`).toBe(false);
    }
  });

  it('una cadena vacía (ECS inyecta "" si no está puesta) cuenta como ausente', () => {
    const p = crearSquareProvider({ ...MONTADO, ...OAUTH, SQUARE_REFRESH_TOKEN: '' });
    expect(p?.capabilities.tapToPay).toBe(false);
  });
});
