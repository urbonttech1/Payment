/**
 * Las cifras de `MISMO_QUE_HOY` NO están calculadas por este código: salen de
 * ejecutar `calcularReparto` de `urbont-api` (`server/services/rideMetrics.ts`),
 * que es la que reparte el dinero en producción hoy.
 *
 * Es la prueba de que portar el cálculo no cambió el reparto de nadie. Si algún
 * día hay que cambiar un número de esta tabla, es un cambio de negocio y
 * tiene que ser deliberado: por eso están escritos a mano.
 */

import { describe, expect, it } from 'vitest';
import { RepartoImposibleError, calcularReparto, sumaDelReparto } from './reparto';

const parte = (r: ReturnType<typeof calcularReparto>, tipo: 'driver' | 'valet' | 'platform') =>
  r.partes.find((p) => p.type === tipo)?.amountCents ?? 0;

const MISMO_QUE_HOY = [
  {
    nombre: 'un viaje de $110 sin nada más',
    entrada: { capturedCents: 11000, commissionRate: 0.15 },
    driver: 9350, valet: 0, platform: 1650,
  },
  {
    nombre: 'con impuesto y el booking de $2.50',
    entrada: { capturedCents: 3142, taxCents: 192, bookingFeeCents: 250, commissionRate: 0.15 },
    driver: 2257, valet: 0, platform: 885,
  },
  {
    nombre: 'valet, booking y aeropuerto a la vez',
    entrada: { capturedCents: 11715, taxCents: 715, valetCents: 1000, bookingFeeCents: 250, accessFeeCents: 1000, commissionRate: 0.15 },
    driver: 7400, valet: 1000, platform: 3315,
  },
  {
    nombre: 'el mismo viaje al 10 % en vez del 15 %',
    entrada: { capturedCents: 11715, taxCents: 715, valetCents: 1000, bookingFeeCents: 250, accessFeeCents: 1000, commissionRate: 0.10 },
    driver: 7850, valet: 1000, platform: 2865,
  },
  {
    nombre: 'un servicio tan pequeño que el booking casi se lo come',
    entrada: { capturedCents: 320, taxCents: 20, bookingFeeCents: 250, commissionRate: 0.15 },
    driver: 5, valet: 0, platform: 315,
  },
  {
    nombre: 'todo el precio es la comisión del valet',
    entrada: { capturedCents: 1065, taxCents: 65, valetCents: 1000, bookingFeeCents: 250, commissionRate: 0.15 },
    driver: 0, valet: 1000, platform: 65,
  },
  {
    nombre: 'cifras impares, para fijar el redondeo',
    entrada: { capturedCents: 3550, taxCents: 217, bookingFeeCents: 250, commissionRate: 0.15 },
    driver: 2583, valet: 0, platform: 967,
  },
];

describe('el reparto es el mismo que reparte urbont-api hoy', () => {
  it.each(MISMO_QUE_HOY)('$nombre', ({ entrada, driver, valet, platform }) => {
    const r = calcularReparto(entrada);
    expect(parte(r, 'driver')).toBe(driver);
    expect(parte(r, 'valet')).toBe(valet);
    expect(parte(r, 'platform')).toBe(platform);
  });
});

describe('la invariante: no se crea ni se pierde un centavo', () => {
  it.each(MISMO_QUE_HOY)('$nombre suma lo capturado', ({ entrada }) => {
    expect(sumaDelReparto(calcularReparto(entrada))).toBe(entrada.capturedCents);
  });

  // Barrido amplio: lo que se busca no es un caso concreto, es que NINGUNA
  // combinación de recargos pueda descuadrar la suma ni dejar una parte en
  // negativo. Un reparto que no cuadra es dinero que aparece o desaparece.
  it('ninguna combinación descuadra la suma ni deja una parte negativa', () => {
    for (const capturado of [100, 320, 1065, 3550, 11715, 98765, 1_000_000]) {
      for (const impuesto of [0, 7, 65, 715]) {
        for (const valet of [0, 1, 1000, 3000]) {
          for (const booking of [0, 250]) {
            for (const acceso of [0, 1000]) {
              for (const tasa of [0, 0.1, 0.15, 0.333, 0.5]) {
                for (const descuento of [0, 500, 99_999]) {
                  if (impuesto > capturado) continue;
                  if (valet > capturado - impuesto) continue;
                  const r = calcularReparto({
                    capturedCents: capturado, taxCents: impuesto, valetCents: valet,
                    bookingFeeCents: booking, accessFeeCents: acceso,
                    commissionRate: tasa, driverDeductionCents: descuento,
                  });
                  expect(sumaDelReparto(r)).toBe(capturado);
                  for (const p of r.partes) expect(p.amountCents).toBeGreaterThanOrEqual(0);
                }
              }
            }
          }
        }
      }
    }
  });
});

describe('lo que no se reparte', () => {
  it('el impuesto se queda entero en la plataforma', () => {
    const sin = calcularReparto({ capturedCents: 10000, commissionRate: 0.15 });
    const con = calcularReparto({ capturedCents: 10715, taxCents: 715, commissionRate: 0.15 });
    expect(parte(con, 'driver')).toBe(parte(sin, 'driver'));
    expect(parte(con, 'platform')).toBe(parte(sin, 'platform') + 715);
  });

  // El fallo que la auditoría encontró en urbont-api: sin descontar el recargo
  // del valet, el chofer se llevaba el 85 % de una comisión que es de otro.
  it('la comisión del valet no engorda la parte del chofer', () => {
    const sin = calcularReparto({ capturedCents: 10000, commissionRate: 0.15 });
    const con = calcularReparto({ capturedCents: 11000, valetCents: 1000, commissionRate: 0.15 });
    expect(parte(con, 'driver')).toBe(parte(sin, 'driver'));
    expect(parte(con, 'valet')).toBe(1000);
  });

  it('el aeropuerto va entero a la plataforma y fuera del porcentaje', () => {
    const r = calcularReparto({ capturedCents: 11000, accessFeeCents: 1000, commissionRate: 0.15 });
    // El 15 % sale de $100, no de $110: al chofer le quedan $85.
    expect(parte(r, 'driver')).toBe(8500);
    expect(parte(r, 'platform')).toBe(2500);
  });

  it('el booking sale de la parte del chofer, después del porcentaje', () => {
    const r = calcularReparto({ capturedCents: 10000, bookingFeeCents: 250, commissionRate: 0.15 });
    expect(parte(r, 'driver')).toBe(8500 - 250);
  });
});

describe('las deudas del chofer', () => {
  it('se le descuentan de su parte y se quedan en la plataforma', () => {
    const r = calcularReparto({ capturedCents: 10000, commissionRate: 0.15, driverDeductionCents: 2000 });
    expect(parte(r, 'driver')).toBe(6500);
    expect(parte(r, 'platform')).toBe(3500);
    expect(sumaDelReparto(r)).toBe(10000);
  });

  it('una deuda mayor que su parte no lo deja en negativo', () => {
    const r = calcularReparto({ capturedCents: 10000, commissionRate: 0.15, driverDeductionCents: 999_999 });
    expect(parte(r, 'driver')).toBe(0);
    expect(parte(r, 'platform')).toBe(10000);
    expect(r.detalle.driverDeductionCents).toBe(8500);
  });
});

describe('lo que no acepta', () => {
  it('una tasa fuera de rango', () => {
    expect(() => calcularReparto({ capturedCents: 10000, commissionRate: 0.6 })).toThrow(RepartoImposibleError);
    expect(() => calcularReparto({ capturedCents: 10000, commissionRate: -0.1 })).toThrow(RepartoImposibleError);
    expect(() => calcularReparto({ capturedCents: 10000, commissionRate: NaN })).toThrow(RepartoImposibleError);
  });

  it('centavos que no son centavos', () => {
    expect(() => calcularReparto({ capturedCents: 100.5, commissionRate: 0.15 })).toThrow(RepartoImposibleError);
    expect(() => calcularReparto({ capturedCents: -1, commissionRate: 0.15 })).toThrow(RepartoImposibleError);
  });

  it('un impuesto o un valet mayores que el cobro', () => {
    expect(() => calcularReparto({ capturedCents: 1000, taxCents: 2000, commissionRate: 0.15 })).toThrow(RepartoImposibleError);
    expect(() => calcularReparto({ capturedCents: 1000, valetCents: 2000, commissionRate: 0.15 })).toThrow(RepartoImposibleError);
  });

  it('no hay parte de valet si no hubo valet', () => {
    const r = calcularReparto({ capturedCents: 10000, commissionRate: 0.15 });
    expect(r.partes.map((p) => p.type)).toEqual(['driver', 'platform']);
  });
});
