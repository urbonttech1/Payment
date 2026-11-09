import { describe, expect, it } from 'vitest';
import { compararExtracto, lineaDelCuadre, type CargoDelProcesador, type CobroDelLibro } from './cuadre';

const cargo = (chargeRef: string, netoCents: number): CargoDelProcesador => ({
  chargeRef, providerRef: `pi_${chargeRef.slice(3)}`, netoCents, createdAt: new Date('2026-11-08T10:00:00Z'),
});

const cobro = (chargeKey: string, chargeRef: string | null, netoCents: number): CobroDelLibro => ({
  chargeKey, chargeRef, providerRef: chargeRef ? `pi_${chargeRef.slice(3)}` : null, netoCents,
});

describe('cuando todo cuadra', () => {
  it('ni un descuadre y los totales iguales', () => {
    const r = compararExtracto(
      'stripe',
      [cargo('ch_1', 11715), cargo('ch_2', 500)],
      [cobro('ride_a_authorize', 'ch_1', 11715), cobro('tip_a_authorize', 'ch_2', 500)],
    );

    expect(r.cuadra).toBe(true);
    expect(r.descuadres).toEqual([]);
    expect(r.centavosProcesador).toBe(12215);
    expect(r.centavosPropios).toBe(12215);
  });

  it('el orden de las listas no importa', () => {
    const r = compararExtracto(
      'stripe',
      [cargo('ch_2', 500), cargo('ch_1', 11715)],
      [cobro('ride_a_authorize', 'ch_1', 11715), cobro('tip_a_authorize', 'ch_2', 500)],
    );
    expect(r.cuadra).toBe(true);
  });

  it('dos listas vacías cuadran', () => {
    expect(compararExtracto('stripe', [], []).cuadra).toBe(true);
  });
});

describe('los tres descuadres que importan', () => {
  // El peor de los tres: entró dinero y no sabemos de qué viaje era.
  it('entró dinero que nuestro libro no conoce', () => {
    const r = compararExtracto('stripe', [cargo('ch_ajeno', 9000)], []);

    expect(r.cuadra).toBe(false);
    expect(r.descuadres).toEqual([{
      tipo: 'solo_en_el_procesador',
      chargeRef: 'ch_ajeno',
      chargeKey: null,
      procesadorCents: 9000,
      libroCents: null,
    }]);
    expect(r.soloEnElProcesador).toBe(1);
  });

  it('apuntamos un cobro que el procesador no tiene', () => {
    const r = compararExtracto('stripe', [], [cobro('ride_z_authorize', 'ch_fantasma', 7000)]);

    expect(r.descuadres).toEqual([{
      tipo: 'solo_en_nuestro_libro',
      chargeRef: 'ch_fantasma',
      chargeKey: 'ride_z_authorize',
      procesadorCents: null,
      libroCents: 7000,
    }]);
  });

  // Casi siempre es un reembolso que no se apuntó.
  it('el mismo cargo con dos cifras', () => {
    const r = compararExtracto('stripe', [cargo('ch_1', 6715)], [cobro('ride_a_authorize', 'ch_1', 11715)]);

    expect(r.descuadres).toEqual([{
      tipo: 'importe_distinto',
      chargeRef: 'ch_1',
      chargeKey: 'ride_a_authorize',
      procesadorCents: 6715,
      libroCents: 11715,
    }]);
  });

  // En dinero no hay «casi cuadra».
  it('UN CENTAVO DE DIFERENCIA ES UN DESCUADRE', () => {
    const r = compararExtracto('stripe', [cargo('ch_1', 11716)], [cobro('ride_a_authorize', 'ch_1', 11715)]);
    expect(r.cuadra).toBe(false);
  });
});

describe('lo que NO es un descuadre', () => {
  // Un cobro que nunca se confirmó no tiene cargo. No falta en el extracto:
  // es que no ocurrió.
  it('un cobro nuestro sin cargo no se compara', () => {
    const r = compararExtracto('stripe', [], [cobro('ride_sin_confirmar_authorize', null, 0)]);

    expect(r.cuadra).toBe(true);
    expect(r.cobrosPropios).toBe(1);
  });
});

describe('la línea del registro', () => {
  it('dice CUADRA con los dos totales', () => {
    const linea = lineaDelCuadre(compararExtracto('stripe', [cargo('ch_1', 100)], [cobro('k', 'ch_1', 100)]));
    expect(linea).toContain('CUADRA');
    expect(linea).toContain('100');
  });

  it('dice DESCUADRE y de qué tipo, para no tener que abrir la tabla', () => {
    const linea = lineaDelCuadre(
      compararExtracto('stripe', [cargo('ch_1', 100), cargo('ch_2', 50)], [cobro('k', 'ch_1', 90)]),
    );
    expect(linea).toContain('DESCUADRE');
    expect(linea).toContain('importe_distinto=1');
    expect(linea).toContain('solo_en_el_procesador=1');
  });
});
