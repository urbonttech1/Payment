/**
 * El controlador de tarjetas, probado por su decisión.
 *
 * Lo que de verdad hace este controlador es elegir **quién** atiende y
 * traducirlo a algo que la app pueda obedecer. La firma del cuerpo crudo ya la
 * prueba `charges.controller.test.ts` por HTTP; repetir ese arnés aquí
 * probaría a Nest, no a esto.
 *
 * Lo que importa: si `/capabilities` miente, la app monta el formulario
 * equivocado y no se puede cobrar.
 */

import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ProviderRegistry } from '../providers/provider.registry';
import type { PaymentProvider, ProviderCapabilities, ProviderName } from '../providers/provider.port';
import { CardsController } from './cards.controller';

function proveedor(
  name: ProviderName,
  capabilities: Partial<ProviderCapabilities>,
  extra: Partial<PaymentProvider> = {},
): PaymentProvider {
  return {
    name,
    capabilities: {
      manualCapture: true, partialCapture: true, increaseAuthorization: true,
      savedCards: false, payouts: false, splitAtCapture: false,
      tapToPay: false, bankDebit: false, currencies: ['USD'],
      ...capabilities,
    },
    saveCard: vi.fn(async () => ({ modo: 'guardada' as const, customerRef: 'cus', card: {
      providerRef: 'card_1', provider: name, brand: 'VISA', last4: '1111',
      expMonth: 10, expYear: 2032, isDefault: false,
    } })),
    listCards: vi.fn(async () => []),
    ...extra,
  } as unknown as PaymentProvider;
}

const SQUARE = () => proveedor('square', { savedCards: true });
const STRIPE = () => proveedor('stripe', { savedCards: true });
const ACH = () => proveedor('ach', { savedCards: false });

describe('qué tiene que hacer la app', () => {
  it('con Square dice que tokenice en el cliente', () => {
    const c = new CardsController(new ProviderRegistry([SQUARE()], 'square'));
    const r = c.capacidades();

    expect(r.provider).toBe('square');
    // Es el dato del que cuelga todo: Square exige el token por delante.
    expect(r.tokenizaEnCliente).toBe(true);
  });

  it('con Stripe dice que NO, porque la app confirma un secreto del servidor', () => {
    const c = new CardsController(new ProviderRegistry([STRIPE()], 'stripe'));
    const r = c.capacidades();

    expect(r.provider).toBe('stripe');
    expect(r.tokenizaEnCliente).toBe(false);
  });

  it('responde por el que de verdad atendería, no por el que esté por defecto', () => {
    // El de por defecto no sabe guardar tarjetas: el registro elige otro, y la
    // app tiene que preparar el formulario de ÉSE. Si aquí se contestara por el
    // de por defecto, montaría el formulario equivocado.
    const c = new CardsController(new ProviderRegistry([ACH(), SQUARE()], 'ach'));
    const r = c.capacidades();

    expect(r.provider).toBe('square');
    expect(r.tokenizaEnCliente).toBe(true);
  });
});

describe('guardar una tarjeta', () => {
  it('rechaza un cuerpo sin pagador antes de molestar al procesador', async () => {
    const square = SQUARE();
    const c = new CardsController(new ProviderRegistry([square], 'square'));

    await expect(c.guardar({ idempotencyKey: 'clave-larga-de-prueba' }))
      .rejects.toThrow(BadRequestException);
    expect(square.saveCard).not.toHaveBeenCalled();
  });

  it('pasa el token al procesador tal cual', async () => {
    const square = SQUARE();
    const c = new CardsController(new ProviderRegistry([square], 'square'));

    await c.guardar({
      payerId: 'pax-1',
      idempotencyKey: 'clave-larga-de-prueba',
      cardToken: 'cnon:card-nonce-ok',
    });

    expect(square.saveCard).toHaveBeenCalledWith(
      expect.objectContaining({ payerId: 'pax-1', cardToken: 'cnon:card-nonce-ok' }),
    );
  });

  it('devuelve el modo sin aplanarlo: la app necesita saber si ya terminó', async () => {
    const c = new CardsController(new ProviderRegistry([SQUARE()], 'square'));

    const r = await c.guardar({
      payerId: 'pax-1',
      idempotencyKey: 'clave-larga-de-prueba',
      cardToken: 'cnon:card-nonce-ok',
    });

    // Aplanar esto aquí volvería a esconder la diferencia que el contrato
    // existe para enseñar.
    expect(r).toMatchObject({ provider: 'square', modo: 'guardada' });
  });
});
