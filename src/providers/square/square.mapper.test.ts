/**
 * El vocabulario de Square, traducido.
 *
 * La prueba que importa es la de `traducirEvento`: Square manda
 * `payment.updated` cuando el cobro se aprueba, cuando se cobra y cuando falla,
 * así que el tipo del evento no dice nada y hay que mirar el estado de dentro.
 * Confundirlos sería dar por cobrados viajes que todavía pueden caerse.
 */

import { describe, expect, it } from 'vitest';
import { centavos, dinero, estadoDeCobro, moneda, traducirEvento } from './square.mapper';

describe('centavos', () => {
  it('convierte el bigint de Square a un entero', () => {
    expect(centavos(11715n)).toBe(11715);
  });

  it('un importe ausente es cero, no NaN', () => {
    expect(centavos(null)).toBe(0);
    expect(centavos(undefined)).toBe(0);
  });

  it('nunca devuelve decimales', () => {
    expect(Number.isInteger(centavos(1234))).toBe(true);
  });
});

describe('dinero', () => {
  it('manda el importe como bigint, que es lo que exige el SDK', () => {
    const d = dinero(11715, 'USD');
    expect(d.amount).toBe(11715n);
    expect(typeof d.amount).toBe('bigint');
    expect(d.currency).toBe('USD');
  });
});

describe('moneda', () => {
  it('normaliza a mayúsculas', () => {
    expect(moneda('usd')).toBe('USD');
  });

  it('una moneda que no conocemos se trata como USD, no revienta', () => {
    expect(moneda('JPY')).toBe('USD');
    expect(moneda(null)).toBe('USD');
  });
});

describe('estadoDeCobro', () => {
  it('APPROVED es retenido, NO cobrado', () => {
    expect(estadoDeCobro('APPROVED')).toBe('authorized');
  });

  it('COMPLETED es cobrado', () => {
    expect(estadoDeCobro('COMPLETED')).toBe('captured');
  });

  it('CANCELED y FAILED se distinguen', () => {
    expect(estadoDeCobro('CANCELED')).toBe('voided');
    expect(estadoDeCobro('FAILED')).toBe('failed');
  });

  // Un estado nuevo de Square no puede colarse como «cobrado».
  it('un estado desconocido pide que alguien lo mire', () => {
    expect(estadoDeCobro('ALGO_NUEVO')).toBe('requires_action');
    expect(estadoDeCobro('PENDING')).toBe('requires_action');
    expect(estadoDeCobro(undefined)).toBe('requires_action');
  });
});

describe('traducirEvento', () => {
  const pago = (status: string, amount = 11715) => ({
    event_id: 'ev_1',
    type: 'payment.updated',
    created_at: '2026-11-10T12:00:00Z',
    data: { object: { payment: { id: 'sqpmt_1', status, amount_money: { amount } } } },
  });

  it('el MISMO tipo de evento significa tres cosas distintas', () => {
    expect(traducirEvento(pago('COMPLETED'))?.tipo).toBe('payment.captured');
    expect(traducirEvento(pago('APPROVED'))?.tipo).toBe('payment.authorized');
    expect(traducirEvento(pago('FAILED'))?.tipo).toBe('payment.failed');
  });

  it('un pago pendiente todavía no es nada', () => {
    expect(traducirEvento(pago('PENDING'))).toBeNull();
  });

  it('el importe viaja en centavos', () => {
    expect(traducirEvento(pago('COMPLETED', 500))?.amount).toBe(500);
  });

  // En Square el cargo ES el pago: su `chargeRef` es el mismo id. Sin él, un
  // cobro capturado sólo por aviso se queda sin cargo en el libro, y el cuadre
  // diario lo marca «sólo en el procesador» aunque esté en los dos sitios.
  it('un pago cobrado trae su cargo (en Square, el mismo id del pago)', () => {
    expect(traducirEvento(pago('COMPLETED'))?.chargeRef).toBe('sqpmt_1');
  });

  it('el cargo sólo viaja cuando el pago está cobrado: no hay cargo de lo que se retiene o falla', () => {
    expect(traducirEvento(pago('APPROVED'))?.chargeRef).toBeUndefined();
    expect(traducirEvento(pago('FAILED'))?.chargeRef).toBeUndefined();
  });

  it('un reembolso trae SU referencia aparte de la del cobro', () => {
    const t = traducirEvento({
      event_id: 'ev_2',
      type: 'refund.updated',
      data: { object: { refund: { id: 'sqref_1', payment_id: 'sqpmt_1', status: 'COMPLETED', amount_money: { amount: 500 } } } },
    });
    expect(t?.tipo).toBe('refund.succeeded');
    expect(t?.providerRef).toBe('sqpmt_1');
    expect(t?.objectRef).toBe('sqref_1');
    // El importe es el DEL REEMBOLSO, no el del cobro: confundirlos apuntaría
    // $117 donde se devolvieron $5.
    expect(t?.amount).toBe(500);
  });

  it('un reembolso que no ha salido no se apunta', () => {
    const t = traducirEvento({
      type: 'refund.created',
      data: { object: { refund: { id: 'sqref_1', payment_id: 'sqpmt_1', status: 'PENDING' } } },
    });
    expect(t).toBeNull();
  });

  it('una disputa abierta y una cerrada son eventos distintos', () => {
    const abierta = traducirEvento({
      type: 'dispute.created',
      data: { object: { dispute: { id: 'sqdis_1', payment_id: 'sqpmt_1', state: 'EVIDENCE_REQUIRED' } } },
    });
    const cerrada = traducirEvento({
      type: 'dispute.state.updated',
      data: { object: { dispute: { id: 'sqdis_1', payment_id: 'sqpmt_1', state: 'WON' } } },
    });
    expect(abierta?.tipo).toBe('chargeback.opened');
    expect(cerrada?.tipo).toBe('chargeback.closed');
  });

  it('lo que no nos toca, no se traduce', () => {
    expect(traducirEvento({ type: 'customer.created', data: { object: {} } })).toBeNull();
    expect(traducirEvento({})).toBeNull();
  });
});
