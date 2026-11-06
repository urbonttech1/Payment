/**
 * El reparto de un cobro: quién se lleva cada centavo.
 *
 * Es el único archivo del servicio donde se decide cuánto cobra cada uno, y es
 * puro a propósito: sin base de datos, sin procesador y sin reloj. El dinero de
 * un viaje se puede explicar leyendo esta función.
 *
 * Viene de `urbont-api/server/services/rideMetrics.ts`, con una diferencia
 * deliberada: **aquí la comisión siempre llega como argumento**. Allí, si no se
 * pasaba, se leía la del panel; eso convertía una función pura en una que
 * depende del estado del proceso, y es la razón de que un cobro y su pago
 * pudieran usar tasas distintas si alguien tocaba el panel en medio.
 *
 * Tres reglas que no son evidentes y que vienen del acuerdo con el cliente:
 *
 *  · **El impuesto no se reparte.** Lo retiene la plataforma porque es quien lo
 *    declara. Repartirlo le daba al chofer el 85 % de un impuesto ajeno.
 *  · **La comisión del valet tampoco.** Se le cobra al huésped sumada al
 *    precio, pero es del valet: sin descontarla, el chofer se llevaba el 85 %
 *    de una comisión de otro.
 *  · **El aeropuerto y el puerto van enteros a la plataforma** y no entran en
 *    el porcentaje. El booking fijo sale de la parte del chofer, después del
 *    porcentaje.
 *
 * Y una invariante que se comprueba en las pruebas: **la suma de las partes es
 * exactamente lo que se capturó**. Ni un centavo se crea ni se pierde en el
 * reparto. Las comisiones del procesador no salen de aquí: Stripe las cobra del
 * saldo de la plataforma, así que las absorbe la parte de la plataforma.
 */

import type { Cents } from '../providers/provider.port';

export type TipoDeBeneficiario = 'driver' | 'valet' | 'platform';

export interface DatosDelReparto {
  /** Lo que de verdad entró, impuesto incluido. Es lo que se reparte. */
  capturedCents: Cents;
  /** Impuesto, dentro de `capturedCents`. Lo retiene la plataforma. */
  taxCents?: Cents;
  /** Comisión del valet que despachó, dentro de `capturedCents`. */
  valetCents?: Cents;
  /** Booking fijo que la plataforma retiene, después del porcentaje. */
  bookingFeeCents?: Cents;
  /** Aeropuerto o puerto: entero a la plataforma, fuera del porcentaje. */
  accessFeeCents?: Cents;
  /** La tasa de la plataforma (0.15 = 15 %). Siempre explícita. */
  commissionRate: number;
  /**
   * Lo que se le descuenta al chofer por deudas ya decididas por quien llama
   * (penalidades por soltar reservas). Sale de su parte y se queda en la
   * plataforma, que es la única vía de cobro que existe: hay maquinaria para
   * pagarle a un chofer, ninguna para girarle un cargo.
   */
  driverDeductionCents?: Cents;
}

export interface ParteDelReparto {
  type: TipoDeBeneficiario;
  amountCents: Cents;
  /** Sólo en la parte del chofer: la tasa con la que se calculó. */
  rate?: number;
}

export interface Reparto {
  partes: ParteDelReparto[];
  /** El desglose, para poder explicar el número sin recalcularlo. */
  detalle: {
    serviceCents: Cents;
    commissionCents: Cents;
    taxCents: Cents;
    valetCents: Cents;
    bookingFeeCents: Cents;
    accessFeeCents: Cents;
    driverDeductionCents: Cents;
    commissionRate: number;
  };
}

const TASA_MAXIMA = 0.5;

export class RepartoImposibleError extends Error {
  constructor(detalle: string) {
    super(detalle);
    this.name = 'RepartoImposibleError';
  }
}

function entero(nombre: string, v: number | undefined): Cents {
  const n = v ?? 0;
  if (!Number.isInteger(n) || n < 0) {
    throw new RepartoImposibleError(`${nombre} tiene que ser un entero de centavos no negativo, y es ${v}`);
  }
  return n;
}

export function calcularReparto(d: DatosDelReparto): Reparto {
  const capturado = entero('capturedCents', d.capturedCents);
  const impuesto = entero('taxCents', d.taxCents);
  const valet = entero('valetCents', d.valetCents);
  const booking = entero('bookingFeeCents', d.bookingFeeCents);
  const acceso = entero('accessFeeCents', d.accessFeeCents);
  const descuento = entero('driverDeductionCents', d.driverDeductionCents);

  if (!Number.isFinite(d.commissionRate) || d.commissionRate < 0 || d.commissionRate > TASA_MAXIMA) {
    throw new RepartoImposibleError(
      `la comisión tiene que estar entre 0 y ${TASA_MAXIMA}, y es ${d.commissionRate}`,
    );
  }
  if (impuesto > capturado) {
    throw new RepartoImposibleError(`el impuesto (${impuesto}) no puede superar lo capturado (${capturado})`);
  }

  // El precio del servicio: lo capturado sin el impuesto.
  const precio = capturado - impuesto;
  if (valet > precio) {
    throw new RepartoImposibleError(`la comisión del valet (${valet}) no puede superar el precio (${precio})`);
  }

  // Cada tope se calcula contra lo que queda, no contra el total: así ninguna
  // parte puede volverse negativa por una combinación rara de recargos.
  const accesoReal = Math.min(acceso, precio - valet);
  const servicio = precio - valet - accesoReal;
  const comision = Math.round(servicio * d.commissionRate);
  const bookingReal = Math.min(booking, Math.max(0, servicio - comision));

  const choferBruto = servicio - comision - bookingReal;
  const descuentoReal = Math.min(descuento, choferBruto);
  const chofer = choferBruto - descuentoReal;

  // Lo que queda, por definición: así la suma cuadra con lo capturado sin
  // depender de que esta cuenta y la de arriba coincidan.
  const plataforma = capturado - chofer - valet;

  const partes: ParteDelReparto[] = [{ type: 'driver', amountCents: chofer, rate: d.commissionRate }];
  if (valet > 0) partes.push({ type: 'valet', amountCents: valet });
  partes.push({ type: 'platform', amountCents: plataforma });

  return {
    partes,
    detalle: {
      serviceCents: servicio,
      commissionCents: comision,
      taxCents: impuesto,
      valetCents: valet,
      bookingFeeCents: bookingReal,
      accessFeeCents: accesoReal,
      driverDeductionCents: descuentoReal,
      commissionRate: d.commissionRate,
    },
  };
}

/** La suma de las partes. Se usa en las pruebas y en la comprobación del servicio. */
export function sumaDelReparto(r: Reparto): Cents {
  return r.partes.reduce((t, p) => t + p.amountCents, 0);
}
