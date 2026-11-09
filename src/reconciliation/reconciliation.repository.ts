/**
 * Los cuadres, guardados.
 *
 * Sólo se escriben: un cuadre es una foto de un momento, y corregirla después
 * borraría la prueba de que hubo un descuadre.
 */

import type { ResultadoDelCuadre } from './cuadre';

export interface CuadreParaGuardar extends ResultadoDelCuadre {
  desde: Date;
  hasta: Date;
}

export interface ReconciliationRepository {
  guardar(cuadre: CuadreParaGuardar): Promise<string>;
}

export const RECONCILIATION_REPOSITORY = Symbol('RECONCILIATION_REPOSITORY');
