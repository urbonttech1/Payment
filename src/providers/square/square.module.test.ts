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
