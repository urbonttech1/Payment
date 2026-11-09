/**
 * El cuadre: comparar nuestro libro con el extracto del procesador.
 *
 * Puro a propósito. Lo que entra son dos listas y lo que sale es la lista de
 * descuadres; ni base de datos, ni red, ni reloj. Un cuadre que no se puede
 * probar no sirve para nada, porque el día que avise de un descuadre nadie
 * sabrá si el descuadre es real o es del cuadre.
 *
 * Qué se compara, y por qué así:
 *
 *  · **Por la referencia del cargo** (`ch_…`), no por la del cobro. El extracto
 *    del procesador habla de cargos; un cobro puede no tener ninguno —si nunca
 *    se confirmó— y eso no es un descuadre, es un cobro que no ocurrió.
 *  · **El importe que se compara es el capturado**, no el autorizado. Una
 *    autorización no es dinero.
 *  · **Un cobro nuestro sin cargo no se compara**: no hay con qué.
 *
 * Los tres descuadres que de verdad importan:
 *
 *  1. `solo_en_el_procesador` — entró dinero que nuestro libro no conoce. Es el
 *     peor: significa que cobramos algo y no sabemos de qué viaje era. Durante
 *     la convivencia también lo son los cobros que creó `urbont-api` por su
 *     cuenta, así que el aviso dice cuántos y hay que leerlo sabiendo eso.
 *  2. `solo_en_nuestro_libro` — apuntamos un cobro que el procesador no tiene.
 *     O no ocurrió, o se apuntó con la referencia equivocada.
 *  3. `importe_distinto` — el mismo cargo con dos cifras. Casi siempre es un
 *     reembolso que no se apuntó.
 */

import type { Cents, ProviderName } from '../providers/provider.port';

/** Una línea del extracto del procesador. */
export interface CargoDelProcesador {
  chargeRef: string;
  providerRef: string | null;
  /** Lo capturado, ya descontado lo devuelto. */
  netoCents: Cents;
  createdAt: Date;
}

/** Una línea de nuestro libro. */
export interface CobroDelLibro {
  chargeKey: string;
  chargeRef: string | null;
  providerRef: string | null;
  /** Lo capturado, ya descontado lo que consta devuelto. */
  netoCents: Cents;
}

export type TipoDeDescuadre = 'solo_en_el_procesador' | 'solo_en_nuestro_libro' | 'importe_distinto';

export interface Descuadre {
  tipo: TipoDeDescuadre;
  chargeRef: string | null;
  chargeKey: string | null;
  /** Lo que dice el procesador. */
  procesadorCents: Cents | null;
  /** Lo que dice nuestro libro. */
  libroCents: Cents | null;
}

export interface ResultadoDelCuadre {
  provider: ProviderName;
  cobrosProcesador: number;
  cobrosPropios: number;
  centavosProcesador: Cents;
  centavosPropios: Cents;
  descuadres: Descuadre[];
  /** `false` en cuanto hay un solo descuadre: en dinero no hay «casi». */
  cuadra: boolean;
  /**
   * Cuántos de los descuadres son cobros que el procesador tiene y nosotros
   * no. Se cuenta aparte porque mientras los dos caminos convivan, esto es lo
   * normal y no una alarma.
   */
  soloEnElProcesador: number;
}

export function compararExtracto(
  provider: ProviderName,
  procesador: CargoDelProcesador[],
  libro: CobroDelLibro[],
): ResultadoDelCuadre {
  const descuadres: Descuadre[] = [];

  const porCargo = new Map<string, CobroDelLibro>();
  for (const c of libro) {
    if (c.chargeRef) porCargo.set(c.chargeRef, c);
  }

  const vistos = new Set<string>();

  for (const cargo of procesador) {
    const nuestro = porCargo.get(cargo.chargeRef);
    if (!nuestro) {
      descuadres.push({
        tipo: 'solo_en_el_procesador',
        chargeRef: cargo.chargeRef,
        chargeKey: null,
        procesadorCents: cargo.netoCents,
        libroCents: null,
      });
      continue;
    }
    vistos.add(cargo.chargeRef);
    if (nuestro.netoCents !== cargo.netoCents) {
      descuadres.push({
        tipo: 'importe_distinto',
        chargeRef: cargo.chargeRef,
        chargeKey: nuestro.chargeKey,
        procesadorCents: cargo.netoCents,
        libroCents: nuestro.netoCents,
      });
    }
  }

  for (const nuestro of libro) {
    // Un cobro sin cargo no se compara: no hay con qué. No es un descuadre,
    // es un cobro que no llegó a ocurrir.
    if (!nuestro.chargeRef) continue;
    if (vistos.has(nuestro.chargeRef)) continue;
    descuadres.push({
      tipo: 'solo_en_nuestro_libro',
      chargeRef: nuestro.chargeRef,
      chargeKey: nuestro.chargeKey,
      procesadorCents: null,
      libroCents: nuestro.netoCents,
    });
  }

  const suma = (n: number[]) => n.reduce((t, x) => t + x, 0);

  return {
    provider,
    cobrosProcesador: procesador.length,
    cobrosPropios: libro.length,
    centavosProcesador: suma(procesador.map((c) => c.netoCents)),
    centavosPropios: suma(libro.map((c) => c.netoCents)),
    descuadres,
    cuadra: descuadres.length === 0,
    soloEnElProcesador: descuadres.filter((d) => d.tipo === 'solo_en_el_procesador').length,
  };
}

/** Una línea para el registro y para la alerta. */
export function lineaDelCuadre(r: ResultadoDelCuadre): string {
  const base =
    `[CUADRE] ${r.provider}: procesador ${r.cobrosProcesador} cobros / ${r.centavosProcesador} ¢ · ` +
    `libro ${r.cobrosPropios} / ${r.centavosPropios} ¢`;
  if (r.cuadra) return `${base} · CUADRA`;

  const porTipo = r.descuadres.reduce<Record<string, number>>((acc, d) => {
    acc[d.tipo] = (acc[d.tipo] ?? 0) + 1;
    return acc;
  }, {});
  const detalle = Object.entries(porTipo).map(([t, n]) => `${t}=${n}`).join(' ');
  return `${base} · DESCUADRE (${detalle})`;
}
