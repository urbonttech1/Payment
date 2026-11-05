/**
 * La frontera entre Stripe y URBONT.
 *
 * Todo lo que Stripe dice se traduce aquí a los tipos del contrato, y nada de
 * Stripe pasa de este archivo. Es lo que hace que añadir Square o Adyen no
 * obligue a tocar el resto del servicio: cada uno traduce su vocabulario al
 * mismo, y quien reacciona a un `payment.captured` no sabe de dónde vino.
 *
 * Son funciones puras a propósito: la traducción es donde se cuelan los errores
 * sutiles —un estado que se interpreta al revés, un importe que se lee del
 * campo equivocado— y aquí se pueden probar todos los casos sin red.
 */

import type Stripe from 'stripe';
import type {
  AuthorizationStatus,
  Cents,
  Currency,
  ProviderEvent,
  ProviderEventType,
} from '../provider.port';

/** Los estados de un PaymentIntent, en el vocabulario de URBONT. */
export function estadoDeCobro(estado: Stripe.PaymentIntent.Status): AuthorizationStatus {
  switch (estado) {
    case 'requires_capture':
      return 'authorized';
    case 'succeeded':
      return 'captured';
    case 'canceled':
      return 'voided';
    case 'requires_payment_method':
    case 'requires_confirmation':
    case 'requires_action':
    case 'processing':
      return 'requires_action';
    default: {
      // Si Stripe añade un estado, es mejor pedir acción que dar por bueno un
      // cobro que no entendemos.
      const _exhaustivo: never = estado;
      void _exhaustivo;
      return 'requires_action';
    }
  }
}

/**
 * Lo que de verdad se cobró, en centavos.
 *
 * `amount_received` es lo capturado; `amount` es lo autorizado. Leer el segundo
 * cuando hubo captura parcial —una cancelación con penalización, por ejemplo—
 * haría repartir dinero que nunca entró.
 */
export function importeCapturado(pi: Pick<Stripe.PaymentIntent, 'amount' | 'amount_received'>): Cents {
  return pi.amount_received ?? pi.amount ?? 0;
}

/** La moneda de Stripe (minúsculas) a la del contrato. */
export function moneda(codigo: string): Currency {
  const c = codigo.toUpperCase();
  if (c === 'USD' || c === 'COP' || c === 'EUR' || c === 'MXN') return c;
  // Antes que inventarse una moneda, se dice que no se reconoce: un importe en
  // la moneda equivocada es un error contable que nadie detecta a tiempo.
  throw new Error(`Moneda no soportada por URBONT PAYMENTS: ${codigo}`);
}

/** El identificador del cargo, cuando Stripe lo trae expandido o como texto. */
export function referenciaDelCargo(
  cargo: string | Stripe.Charge | null | undefined,
): string | undefined {
  if (typeof cargo === 'string') return cargo;
  if (cargo && typeof cargo === 'object' && 'id' in cargo) return cargo.id;
  return undefined;
}

/**
 * Los eventos de Stripe que a URBONT le importan.
 *
 * Lo que no esté aquí se confirma y se ignora: un evento desconocido no puede
 * hacer que el webhook devuelva error, porque Stripe lo reintentaría en bucle.
 */
const EVENTOS: Record<string, ProviderEventType> = {
  'payment_intent.amount_capturable_updated': 'payment.authorized',
  'payment_intent.succeeded': 'payment.captured',
  'payment_intent.payment_failed': 'payment.failed',
  'charge.refunded': 'refund.succeeded',
  'refund.created': 'refund.succeeded',
  'refund.updated': 'refund.succeeded',
  'charge.dispute.created': 'chargeback.opened',
  'charge.dispute.closed': 'chargeback.closed',
  'account.updated': 'payee.updated',
  'payout.paid': 'payout.paid',
  'payout.failed': 'payout.failed',
};

/** `true` si ese tipo de evento mueve algo en URBONT. */
export function eventoRelevante(tipo: string): boolean {
  return tipo in EVENTOS;
}

/** El objeto del evento, con los campos que nos interesan de cualquier tipo. */
interface ObjetoDeEvento {
  id?: string;
  amount?: number;
  amount_received?: number;
  currency?: string;
  payment_intent?: string | { id?: string } | null;
}

/**
 * Traduce un evento de Stripe al del contrato, o `null` si no nos concierne.
 *
 * La referencia que se devuelve es siempre la del cobro (`pi_…`), no la del
 * objeto que disparó el evento: así un reembolso y su cobro se reconcilian
 * contra la misma fila sin tener que preguntarle otra vez a Stripe.
 */
export function traducirEvento(evento: Stripe.Event): ProviderEvent | null {
  const tipo = EVENTOS[evento.type];
  if (!tipo) return null;

  const objeto = evento.data.object as ObjetoDeEvento;
  const pi = objeto.payment_intent;
  const referenciaCobro =
    typeof pi === 'string' ? pi : pi && typeof pi === 'object' ? (pi.id ?? null) : null;

  return {
    eventId: evento.id,
    provider: 'stripe',
    type: tipo,
    // Para un payment_intent.*, el propio objeto es el cobro.
    providerRef: referenciaCobro ?? objeto.id ?? null,
    amount: objeto.amount_received ?? objeto.amount,
    currency: objeto.currency ? moneda(objeto.currency) : undefined,
    occurredAt: new Date(evento.created * 1000),
    raw: evento,
  };
}

/**
 * El motivo del reembolso, en el vocabulario de Stripe.
 *
 * Stripe sólo admite tres, y uno de ellos (`fraudulent`) tiene consecuencias:
 * marca al cliente. Por eso se traduce explícitamente en vez de dejar pasar
 * cualquier texto.
 */
export function motivoDeReembolso(
  motivo: 'duplicate' | 'fraudulent' | 'requested_by_customer' | undefined,
): Stripe.RefundCreateParams.Reason | undefined {
  return motivo;
}
