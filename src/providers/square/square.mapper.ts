/**
 * El vocabulario de Square traducido al del contrato.
 *
 * Igual que con Stripe: aquí y sólo aquí se nombran sus estados y sus tipos.
 * Si mañana cambian, cambia este archivo y nada más.
 */

import { createHash } from 'node:crypto';
import type { Currency as MonedaDeSquare } from 'square';
import type { Cents, Currency, AuthorizationStatus, ProviderEventType } from '../provider.port';

/**
 * Lo más largo que admite Square como clave de idempotencia.
 *
 * Con una más larga responde `INVALID_REQUEST_ERROR: Field must not be greater
 * than 45 length`. Las que genera urbont-api pasan de ahí —`ride_<uuid>_authorize`
 * son 51 caracteres, y con `_capture` o `_refund` unos 59—, así que sin acortarlas
 * ningún cobro, captura, reembolso ni tarjeta guardada por Square habría llegado a
 * hacerse. Se vio en producción como una ristra de 502 en `POST /internal/cards`.
 */
export const LIMITE_CLAVE_SQUARE = 45;

/** Marca lo acortado: `h1` = hash, versión 1. Si algún día cambia el esquema, cambia el número. */
const MARCA_DE_CLAVE_ACORTADA = 'h1_';

/**
 * La clave tal como se la manda a Square: la misma si cabe, y un hash si no.
 *
 * **Tiene que ser determinista**, y lo es: la misma entrada da siempre la misma
 * salida. La idempotencia consiste justo en eso —un reintento del mismo cobro
 * llega con la misma clave, y Square lo reconoce en vez de cobrar otra vez—, así
 * que una clave acortada al azar sería peor que no acortarla.
 *
 * Es SHA-256 en base64url y no un corte de los primeros caracteres: las claves se
 * parecen mucho entre sí (`ride_<uuid>_authorize` frente a `…_capture`), y
 * cortarlas por el final haría chocar las operaciones de un mismo viaje, que es
 * exactamente lo que la clave tiene que evitar. 42 caracteres de base64url son 252
 * bits: no hay riesgo práctico de que dos claves distintas den la misma.
 *
 * Lo que ya cabe se deja intacto. No hay motivo para tocarlo, y así lo que ya se
 * mandó a Square con una clave corta sigue siendo reconocible.
 */
export function claveDeSquare(clave: string): string {
  if (clave.length <= LIMITE_CLAVE_SQUARE) return clave;
  const hash = createHash('sha256').update(clave).digest('base64url');
  return `${MARCA_DE_CLAVE_ACORTADA}${hash.slice(0, LIMITE_CLAVE_SQUARE - MARCA_DE_CLAVE_ACORTADA.length)}`;
}

/** Square cuenta el dinero en la unidad mínima, pero con `bigint`. */
export function centavos(amount: bigint | number | null | undefined): Cents {
  if (amount === null || amount === undefined) return 0;
  const n = typeof amount === 'bigint' ? Number(amount) : amount;
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * Un importe en el formato de Square: `bigint` y su propio tipo de moneda.
 *
 * Las cuatro monedas del contrato existen en el catálogo de Square, así que no
 * hay traducción que hacer; lo que hay es un tipo que el SDK exige y que se
 * queda dentro de este archivo, como todo lo demás que sea suyo.
 */
export function dinero(cents: Cents, currency: Currency): { amount: bigint; currency: MonedaDeSquare } {
  return { amount: BigInt(Math.round(cents)), currency };
}

export function moneda(codigo: string | null | undefined): Currency {
  const c = (codigo ?? 'USD').toUpperCase();
  return (['USD', 'COP', 'EUR', 'MXN'] as const).includes(c as Currency) ? (c as Currency) : 'USD';
}

/**
 * El estado de un pago de Square, en el vocabulario del contrato.
 *
 * `APPROVED` es lo que Stripe llama `requires_capture`: el dinero está
 * retenido y no cobrado. Confundirlo con cobrado sería dar por buenos viajes
 * que todavía pueden caerse.
 */
export function estadoDeCobro(estado: string | null | undefined): AuthorizationStatus {
  switch ((estado ?? '').toUpperCase()) {
    case 'APPROVED':
      return 'authorized';
    case 'COMPLETED':
      return 'captured';
    case 'CANCELED':
      return 'voided';
    case 'FAILED':
      return 'failed';
    case 'PENDING':
    case '':
    default:
      // Un estado que no conocemos no se da por bueno: que alguien lo mire.
      return 'requires_action';
  }
}

/**
 * Los avisos de Square que mueven algo en URBONT.
 *
 * Square nombra los suyos `payment.updated`, no `payment_intent.succeeded`, así
 * que el tipo de evento no basta: hay que mirar el estado del pago que trae
 * dentro. De eso se encarga `traducirEvento`.
 */
const EVENTOS_DE_PAGO = new Set(['payment.created', 'payment.updated']);

export interface EventoDeSquare {
  event_id?: string;
  type?: string;
  created_at?: string;
  data?: {
    object?: {
      payment?: { id?: string; status?: string; amount_money?: { amount?: number | string } };
      refund?: { id?: string; payment_id?: string; status?: string; amount_money?: { amount?: number | string } };
      dispute?: { id?: string; payment_id?: string; state?: string; amount_money?: { amount?: number | string } };
    };
  };
}

export interface EventoTraducido {
  tipo: ProviderEventType;
  providerRef: string | null;
  objectRef: string | null;
  amount?: Cents;
}

/**
 * Qué significa para URBONT un aviso de Square, o `null` si no significa nada.
 *
 * Se mira el ESTADO y no sólo el tipo: `payment.updated` llega cuando el pago
 * se aprueba, cuando se completa y cuando falla, y las tres cosas son eventos
 * distintos para nosotros.
 */
export function traducirEvento(evento: EventoDeSquare): EventoTraducido | null {
  const tipo = (evento.type ?? '').toLowerCase();
  const objeto = evento.data?.object ?? {};

  if (EVENTOS_DE_PAGO.has(tipo) && objeto.payment) {
    const estado = estadoDeCobro(objeto.payment.status);
    const importe = centavos(Number(objeto.payment.amount_money?.amount ?? 0));
    const base = { providerRef: objeto.payment.id ?? null, objectRef: objeto.payment.id ?? null, amount: importe };

    if (estado === 'captured') return { tipo: 'payment.captured', ...base };
    if (estado === 'authorized') return { tipo: 'payment.authorized', ...base };
    if (estado === 'failed') return { tipo: 'payment.failed', ...base };
    return null; // pendiente o anulado: nada que hacer todavía
  }

  if (tipo.startsWith('refund.') && objeto.refund) {
    // Sólo cuenta el reembolso que de verdad salió.
    if ((objeto.refund.status ?? '').toUpperCase() !== 'COMPLETED') return null;
    return {
      tipo: 'refund.succeeded',
      providerRef: objeto.refund.payment_id ?? null,
      objectRef: objeto.refund.id ?? null,
      amount: centavos(Number(objeto.refund.amount_money?.amount ?? 0)),
    };
  }

  if (tipo.startsWith('dispute.') && objeto.dispute) {
    const estado = (objeto.dispute.state ?? '').toUpperCase();
    const cerrada = ['WON', 'LOST', 'ACCEPTED'].includes(estado);
    return {
      tipo: cerrada ? 'chargeback.closed' : 'chargeback.opened',
      providerRef: objeto.dispute.payment_id ?? null,
      objectRef: objeto.dispute.id ?? null,
      amount: centavos(Number(objeto.dispute.amount_money?.amount ?? 0)),
    };
  }

  return null;
}
