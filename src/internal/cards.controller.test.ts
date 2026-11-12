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
import type { PreferredCardsRepository } from './preferred-cards.repository';

/** Sin preferencia guardada: manda la primera tarjeta, como antes. */
function preferidasFalsas(cardRef: string | null = null): PreferredCardsRepository {
  return {
    obtener: vi.fn(async () => cardRef),
    fijar: vi.fn(async () => {}),
    olvidar: vi.fn(async () => {}),
  } as unknown as PreferredCardsRepository;
}

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
    const c = new CardsController(new ProviderRegistry([SQUARE()], 'square'), preferidasFalsas());
    const r = c.capacidades();

    expect(r.provider).toBe('square');
    // Es el dato del que cuelga todo: Square exige el token por delante.
    expect(r.tokenizaEnCliente).toBe(true);
  });

  it('con Stripe dice que NO, porque la app confirma un secreto del servidor', () => {
    const c = new CardsController(new ProviderRegistry([STRIPE()], 'stripe'), preferidasFalsas());
    const r = c.capacidades();

    expect(r.provider).toBe('stripe');
    expect(r.tokenizaEnCliente).toBe(false);
  });

  it('responde por el que de verdad atendería, no por el que esté por defecto', () => {
    // El de por defecto no sabe guardar tarjetas: el registro elige otro, y la
    // app tiene que preparar el formulario de ÉSE. Si aquí se contestara por el
    // de por defecto, montaría el formulario equivocado.
    const c = new CardsController(new ProviderRegistry([ACH(), SQUARE()], 'ach'), preferidasFalsas());
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
    const c = new CardsController(new ProviderRegistry([square], 'square'), preferidasFalsas());

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
    const c = new CardsController(new ProviderRegistry([square], 'square'), preferidasFalsas());

    // Un pasajero sin tarjetas no es un error: tratarlo como tal haría que su
    // cartera pareciera rota en vez de vacía.
    await expect(c.porPagador('pax-nuevo')).resolves.toEqual([]);
    expect(square.listCards).not.toHaveBeenCalled();
  });

  it('devuelve lista vacía si el procesador no sabe buscar por pagador', async () => {
    // `findCustomer` es opcional en el contrato: un adaptador que no lo
    // implemente no puede tumbar la pantalla de la cartera.
    const c = new CardsController(new ProviderRegistry([proveedor('stripe', { savedCards: true })], 'stripe'), preferidasFalsas());
    await expect(c.porPagador('pax-1')).resolves.toEqual([]);
  });
});

describe('la tarjeta principal', () => {
  const dos = () => proveedor('square', { savedCards: true }, {
    findCustomer: vi.fn(async () => 'cus_sq'),
    listCards: vi.fn(async () => [
      { providerRef: 'ccof_1', provider: 'square', brand: 'VISA', last4: '1111', expMonth: 1, expYear: 2030, isDefault: false },
      { providerRef: 'ccof_2', provider: 'square', brand: 'MC', last4: '2222', expMonth: 2, expYear: 2031, isDefault: false },
    ]),
  });

  it('sin preferencia guardada, manda la primera', async () => {
    const c = new CardsController(new ProviderRegistry([dos()], 'square'), preferidasFalsas());
    const r = await c.porPagador('pax-1') as { providerRef: string; isDefault: boolean }[];

    expect(r.find((t) => t.isDefault)?.providerRef).toBe('ccof_1');
  });

  it('con preferencia guardada, manda esa aunque no sea la primera', async () => {
    const c = new CardsController(new ProviderRegistry([dos()], 'square'), preferidasFalsas('ccof_2'));
    const r = await c.porPagador('pax-1') as { providerRef: string; isDefault: boolean }[];

    expect(r.find((t) => t.isDefault)?.providerRef).toBe('ccof_2');
    // Y sólo una: dos principales es no tener ninguna.
    expect(r.filter((t) => t.isDefault)).toHaveLength(1);
  });

  it('no deja fijar una tarjeta que no es del pagador', async () => {
    const preferidas = preferidasFalsas();
    const c = new CardsController(new ProviderRegistry([dos()], 'square'), preferidas);

    // Sin esta comprobación, mandar el identificador de la tarjeta de otro
    // bastaría para que le cobraran a él.
    await expect(c.fijarPreferida('pax-1', { cardRef: 'ccof_de_otro' })).rejects.toThrow();
    expect(preferidas.fijar).not.toHaveBeenCalled();
  });

  it('fija la suya y la guarda con el procesador que la emitió', async () => {
    const preferidas = preferidasFalsas();
    const c = new CardsController(new ProviderRegistry([dos()], 'square'), preferidas);

    await c.fijarPreferida('pax-1', { cardRef: 'ccof_2' });

    // El procesador va junto a la tarjeta porque una tarjeta pertenece al que
    // la guardó: una preferencia de Stripe no significa nada si cobra Square.
    expect(preferidas.fijar).toHaveBeenCalledWith('pax-1', 'square', 'ccof_2');
  });
});

describe('guardar una tarjeta', () => {
  it('rechaza un cuerpo sin pagador antes de molestar al procesador', async () => {
    const square = SQUARE();
    const c = new CardsController(new ProviderRegistry([square], 'square'), preferidasFalsas());

    await expect(c.guardar({ idempotencyKey: 'clave-larga-de-prueba' }))
      .rejects.toThrow(BadRequestException);
    expect(square.saveCard).not.toHaveBeenCalled();
  });

  it('pasa el token al procesador tal cual', async () => {
    const square = SQUARE();
    const c = new CardsController(new ProviderRegistry([square], 'square'), preferidasFalsas());

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
    const c = new CardsController(new ProviderRegistry([SQUARE()], 'square'), preferidasFalsas());

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
