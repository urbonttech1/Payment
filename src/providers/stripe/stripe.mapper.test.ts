import { describe, it, expect } from 'vitest';
import type Stripe from 'stripe';
import {
  estadoDeCobro,
  importeCapturado,
  moneda,
  referenciaDelCargo,
  eventoRelevante,
  traducirEvento,
} from './stripe.mapper';

describe('estadoDeCobro', () => {
  it('un cobro retenido está autorizado, no cobrado', () => {
    expect(estadoDeCobro('requires_capture')).toBe('authorized');
  });

  it('distingue cobrado, anulado y pendiente de acción', () => {
    expect(estadoDeCobro('succeeded')).toBe('captured');
    expect(estadoDeCobro('canceled')).toBe('voided');
    expect(estadoDeCobro('requires_action')).toBe('requires_action');
    expect(estadoDeCobro('requires_payment_method')).toBe('requires_action');
    expect(estadoDeCobro('processing')).toBe('requires_action');
  });

  it('ante un estado que no conoce, pide acción en vez de darlo por bueno', () => {
    expect(estadoDeCobro('un_estado_nuevo' as Stripe.PaymentIntent.Status)).toBe('requires_action');
  });
});

describe('importeCapturado', () => {
  it('lee lo capturado, no lo autorizado', () => {
    // Una cancelación con penalización: se autorizaron $110 y se cobraron $55.
    expect(importeCapturado({ amount: 11000, amount_received: 5500 })).toBe(5500);
  });

  it('cae en lo autorizado cuando todavía no hay captura', () => {
    expect(importeCapturado({ amount: 11000, amount_received: 0 })).toBe(0);
    expect(importeCapturado({ amount: 11000, amount_received: null as unknown as number })).toBe(11000);
  });
});

describe('moneda', () => {
  it('traduce las que URBONT maneja', () => {
    expect(moneda('usd')).toBe('USD');
    expect(moneda('COP')).toBe('COP');
  });

  it('se niega a adivinar una que no conoce', () => {
    expect(() => moneda('jpy')).toThrow(/no soportada/i);
  });
});

describe('referenciaDelCargo', () => {
  it('acepta el id suelto y el objeto expandido', () => {
    expect(referenciaDelCargo('ch_123')).toBe('ch_123');
    expect(referenciaDelCargo({ id: 'ch_456' } as Stripe.Charge)).toBe('ch_456');
  });

  it('devuelve undefined cuando no hay cargo', () => {
    expect(referenciaDelCargo(null)).toBeUndefined();
    expect(referenciaDelCargo(undefined)).toBeUndefined();
  });
});

function evento(tipo: string, objeto: Record<string, unknown>, id = 'evt_1'): Stripe.Event {
  return {
    id,
    type: tipo,
    created: 1_762_000_000,
    data: { object: objeto },
  } as unknown as Stripe.Event;
}

describe('traducirEvento', () => {
  it('traduce un cobro completado', () => {
    const e = traducirEvento(evento('payment_intent.succeeded', {
      id: 'pi_123', amount: 11000, amount_received: 11000, currency: 'usd',
    }));
    expect(e).toMatchObject({
      eventId: 'evt_1',
      provider: 'stripe',
      type: 'payment.captured',
      providerRef: 'pi_123',
      amount: 11000,
      currency: 'USD',
    });
  });

  it('ancla el reembolso al cobro, no al objeto del reembolso', () => {
    const e = traducirEvento(evento('charge.refunded', {
      id: 'ch_999', payment_intent: 'pi_123', amount: 5000, currency: 'usd',
    }));
    expect(e?.type).toBe('refund.succeeded');
    expect(e?.providerRef).toBe('pi_123');
  });

  it('entiende el cobro expandido como objeto', () => {
    const e = traducirEvento(evento('refund.created', {
      id: 're_1', payment_intent: { id: 'pi_abc' }, amount: 100, currency: 'usd',
    }));
    expect(e?.providerRef).toBe('pi_abc');
  });

  it('traduce contracargos y cambios de cuenta del beneficiario', () => {
    expect(traducirEvento(evento('charge.dispute.created', { id: 'dp_1', currency: 'usd' }))?.type)
      .toBe('chargeback.opened');
    expect(traducirEvento(evento('account.updated', { id: 'acct_1' }))?.type)
      .toBe('payee.updated');
  });

  it('devuelve null para lo que no nos concierne', () => {
    expect(traducirEvento(evento('customer.created', { id: 'cus_1' }))).toBeNull();
    expect(eventoRelevante('customer.created')).toBe(false);
    expect(eventoRelevante('payment_intent.succeeded')).toBe(true);
  });

  it('conserva la hora del evento y el original completo', () => {
    const bruto = evento('payment_intent.payment_failed', { id: 'pi_x', currency: 'usd' });
    const e = traducirEvento(bruto);
    expect(e?.occurredAt.toISOString()).toBe(new Date(1_762_000_000 * 1000).toISOString());
    expect(e?.raw).toBe(bruto);
  });
});
