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

describe('listar las tarjetas de un pagador', () => {
  it('lo busca por el id de URBONT y devuelve sus tarjetas', async () => {
    const square = proveedor('square', { savedCards: true }, {
      findCustomer: vi.fn(async () => 'cus_sq'),
      listCards: vi.fn(async () => [{ providerRef: 'ccof_1', provider: 'square', brand: 'VISA', last4: '5858', expMonth: 11, expYear: 2028, isDefault: false }]),
    });
    const c = new CardsController(new ProviderRegistry([square], 'square'));

    const r = await c.porPagador('pax-1');

    expect(square.findCustomer).toHaveBeenCalledWith('pax-1');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ last4: '5858' });
  });

  it('devuelve lista vacía si el pagador no tiene cliente todavía', async () => {
    const square = proveedor('square', { savedCards: true }, {
      findCustomer: vi.fn(async () => null),
      listCards: vi.fn(async () => { throw new Error('no debería llamarse'); }),
    });
    const c = new CardsController(new ProviderRegistry([square], 'square'));

    // Un pasajero sin tarjetas no es un error: tratarlo como tal haría que su
    // cartera pareciera rota en vez de vacía.
    await expect(c.porPagador('pax-nuevo')).resolves.toEqual([]);
    expect(square.listCards).not.toHaveBeenCalled();
  });

  it('devuelve lista vacía si el procesador no sabe buscar por pagador', async () => {
    // `findCustomer` es opcional en el contrato: un adaptador que no lo
    // implemente no puede tumbar la pantalla de la cartera.
    const c = new CardsController(new ProviderRegistry([proveedor('stripe', { savedCards: true })], 'stripe'));
    await expect(c.porPagador('pax-1')).resolves.toEqual([]);
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
