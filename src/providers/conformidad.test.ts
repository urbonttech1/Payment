/**
 * Las pruebas de la suite de pruebas.
 *
 * Suena recursivo, pero es lo que la hace valer: si estas heurísticas no cazan
 * los fallos que ya costaron dinero, la suite pasaría siempre y daría una
 * confianza falsa a quien escriba el segundo adaptador.
 */

import { describe, expect, it } from 'vitest';
import { llevaLaClave, mencionaReparto } from './conformidad';

describe('caza el reparto escondido en el cobro', () => {
  // La forma exacta del hallazgo 04: el cobro llevaba el destino dentro y
  // además se transfería al terminar. El chofer cobraba dos veces.
  it('EL transfer_data QUE COSTÓ $89 EN UN VIAJE DE $110', () => {
    expect(mencionaReparto([{ amount: 11000, transfer_data: { destination: 'acct_1' } }])).toBe('transfer_data');
  });

  it('y la comisión mandada en el cobro', () => {
    expect(mencionaReparto([{ amount: 11000, application_fee_amount: 1650 }])).toBe('application_fee');
  });

  it.each([
    ['Square', { app_fee_money: { amount: 100 } }],
    ['Square multiparte', { additional_recipients: [{ location_id: 'L1' }] }],
    ['Adyen', { splits: [{ account: 'BA1', amount: { value: 900 } }] }],
    ['cualquiera', { on_behalf_of: 'acct_1' }],
  ])('también en el vocabulario de %s', (_quien, cuerpo) => {
    expect(mencionaReparto([cuerpo])).not.toBeNull();
  });

  it('un cobro limpio pasa', () => {
    expect(mencionaReparto([
      { amount: 11000, currency: 'usd', capture_method: 'manual', metadata: { ride_id: 'r1' } },
      { idempotencyKey: 'ride_r1_authorize' },
    ])).toBeNull();
  });

  // Mira dentro, no sólo en las claves de primer nivel.
  it('no se le escapa anidado', () => {
    expect(mencionaReparto([{ payment: { nested: { transfer_data: { destination: 'x' } } } }])).toBe('transfer_data');
  });
});

describe('caza la clave de idempotencia que falta', () => {
  // La comisión del valet era la única transferencia de nueve sin clave: un
  // reintento la pagaba dos veces.
  it('una transferencia sin clave no pasa', () => {
    expect(llevaLaClave([{ amount: 1000, destination: 'acct_1' }], 'valet_commission_r1')).toBe(false);
  });

  it('con clave, pase donde pase: cuerpo, opciones o cabecera', () => {
    expect(llevaLaClave([{ amount: 1000 }, { idempotencyKey: 'k_1' }], 'k_1')).toBe(true);
    expect(llevaLaClave([{ amount: 1000, reference: 'k_1' }], 'k_1')).toBe(true);
    expect(llevaLaClave([{}, { headers: { 'Idempotency-Key': 'k_1' } }], 'k_1')).toBe(true);
  });

  it('una petición que no se puede serializar no finge que la lleva', () => {
    const circular: Record<string, unknown> = {};
    circular.yo = circular;
    expect(llevaLaClave(circular, 'k_1')).toBe(false);
  });
});
