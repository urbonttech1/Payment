import { describe, it, expect } from 'vitest';
import { ProviderRegistry, ProviderNotAvailableError } from './provider.registry';
import type { PaymentProvider, ProviderCapabilities, ProviderName } from './provider.port';

function fake(name: ProviderName, caps: Partial<ProviderCapabilities> = {}): PaymentProvider {
  const capabilities: ProviderCapabilities = {
    manualCapture: false,
    partialCapture: false,
    savedCards: false,
    payouts: false,
    splitAtCapture: false,
    tapToPay: false,
    bankDebit: false,
    currencies: ['USD'],
    ...caps,
  };
  return { name, capabilities } as PaymentProvider;
}

describe('ProviderRegistry', () => {
  const stripe = fake('stripe', { manualCapture: true, savedCards: true, payouts: true, tapToPay: true });
  const adyen = fake('adyen', { manualCapture: true, savedCards: true, payouts: true, splitAtCapture: true });
  const paypal = fake('paypal', { savedCards: true });

  it('lista lo que tiene montado', () => {
    const r = new ProviderRegistry([stripe, adyen], 'stripe');
    expect(r.disponibles()).toEqual(['stripe', 'adyen']);
  });

  describe('un cobro existente vuelve siempre a quien lo originó', () => {
    it('aunque el procesador por defecto sea otro', () => {
      const r = new ProviderRegistry([stripe, adyen], 'adyen');
      expect(r.paraCobroExistente('stripe').name).toBe('stripe');
    });

    it('y falla claro si ese procesador ya no está montado', () => {
      const r = new ProviderRegistry([adyen], 'adyen');
      expect(() => r.paraCobroExistente('stripe')).toThrow(ProviderNotAvailableError);
      expect(() => r.paraCobroExistente('stripe')).toThrow(/stripe/);
    });
  });

  describe('un cobro nuevo', () => {
    it('va al procesador por defecto', () => {
      const r = new ProviderRegistry([stripe, adyen], 'adyen');
      expect(r.paraCobroNuevo().name).toBe('adyen');
    });

    it('va al por defecto cuando sí sabe hacer lo que hace falta', () => {
      const r = new ProviderRegistry([stripe, adyen], 'stripe');
      expect(r.paraCobroNuevo(['manualCapture', 'tapToPay']).name).toBe('stripe');
    });

    it('se desvía al que sabe cuando el por defecto no puede', () => {
      const r = new ProviderRegistry([stripe, adyen], 'adyen');
      expect(r.paraCobroNuevo(['tapToPay']).name).toBe('stripe');
    });

    it('falla diciendo qué capacidad faltaba', () => {
      const r = new ProviderRegistry([paypal], 'paypal');
      expect(() => r.paraCobroNuevo(['tapToPay'])).toThrow(/tapToPay/);
    });

    it('falla si no hay ningún procesador montado', () => {
      const r = new ProviderRegistry([], 'stripe');
      expect(() => r.paraCobroNuevo()).toThrow(ProviderNotAvailableError);
    });
  });

  // Una app ya publicada espera un token y un cobro de Stripe; la nueva espera los
  // de Square. Con Square por defecto, el registro no puede decidirlo solo: quien
  // llama dice cuál prefiere, y esa preferencia manda mientras se pueda cumplir.
  describe('un cobro nuevo con proveedor preferido', () => {
    const square = fake('square', { manualCapture: true, savedCards: true, tapToPay: true });

    it('LA PREFERENCIA MANDA sobre el procesador por defecto, si sabe hacer lo que hace falta', () => {
      const r = new ProviderRegistry([stripe, square], 'square');
      expect(r.paraCobroNuevo(['tapToPay'], 'stripe').name).toBe('stripe');
      expect(r.paraCobroNuevo(['tapToPay'], 'square').name).toBe('square');
    });

    it('sin preferencia, todo sigue como antes: el por defecto', () => {
      const r = new ProviderRegistry([stripe, square], 'square');
      expect(r.paraCobroNuevo(['tapToPay']).name).toBe('square');
      expect(r.paraCobroNuevo(['tapToPay'], undefined).name).toBe('square');
    });

    it('si el preferido no está montado, no se rompe el cobro: se usa el que haya (y se avisa)', () => {
      const r = new ProviderRegistry([stripe], 'stripe');
      expect(r.paraCobroNuevo(['tapToPay'], 'square').name).toBe('stripe');
    });

    it('si el preferido no sabe hacer lo que hace falta, tampoco se rompe', () => {
      const sinTap = fake('square', { manualCapture: true });
      const r = new ProviderRegistry([stripe, sinTap], 'stripe');
      expect(r.paraCobroNuevo(['tapToPay'], 'square').name).toBe('stripe');
    });

    it('si nadie puede, falla igual que sin preferencia', () => {
      const r = new ProviderRegistry([paypal], 'paypal');
      expect(() => r.paraCobroNuevo(['tapToPay'], 'square')).toThrow(ProviderNotAvailableError);
    });
  });
});

// El procesador por defecto se edita desde el panel, así que no puede quedarse
// fijado en el arranque: cambiarlo obligaría a redesplegar.
describe('cambiar el procesador en caliente', () => {
  it('los cobros nuevos pasan al nuevo', () => {
    const r = new ProviderRegistry([fake('stripe'), fake('adyen')], 'stripe');
    expect(r.paraCobroNuevo().name).toBe('stripe');

    r.fijarPorDefecto('adyen');

    expect(r.porDefecto).toBe('adyen');
    expect(r.paraCobroNuevo().name).toBe('adyen');
  });

  // La regla 1 del contrato no se negocia ni desde el panel.
  it('UN COBRO EXISTENTE SIGUE EN EL SUYO', () => {
    const r = new ProviderRegistry([fake('stripe'), fake('adyen')], 'stripe');
    r.fijarPorDefecto('adyen');
    expect(r.paraCobroExistente('stripe').name).toBe('stripe');
  });

  // Dejar el servicio apuntando a un procesador sin credenciales convertiría
  // todos los cobros nuevos en un error, y el panel no tendría cómo volver.
  it('no se puede elegir uno que no está montado', () => {
    const r = new ProviderRegistry([fake('stripe')], 'stripe');
    expect(() => r.fijarPorDefecto('adyen')).toThrow(ProviderNotAvailableError);
    expect(r.porDefecto).toBe('stripe');
  });

  it('ponerlo al que ya está no hace nada', () => {
    const r = new ProviderRegistry([fake('stripe')], 'stripe');
    r.fijarPorDefecto('stripe');
    expect(r.porDefecto).toBe('stripe');
  });
});
