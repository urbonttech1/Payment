/**
 * La línea con la que el servicio dice que ya está listo.
 *
 * Tiene que decir el procesador que de verdad quedó por defecto, **después** de que
 * las credenciales guardadas montaran las suyas, y no el del entorno: con Square
 * elegido en el panel, la línea decía «por defecto: stripe» mientras los cobros
 * nuevos ya iban por Square. Una línea de arranque que miente es peor que no tenerla,
 * porque es la primera que se lee para saber qué quedó desplegado.
 */

export interface DatosDeArranque {
  version: string;
  puerto: number;
  /** El procesador que atiende los cobros nuevos AHORA, según el registro. */
  porDefecto: string;
  /** Los que están montados y pueden cobrar. */
  montados: string[];
}

export function lineaDeArranque(d: DatosDeArranque): string {
  const montados = d.montados.length > 0 ? d.montados.join(', ') : 'ninguno';
  // Un procesador por defecto que no está montado significa que cada cobro nuevo va a
  // fallar. Es lo primero que tiene que verse al arrancar, no al primer pasajero.
  const aviso = d.montados.includes(d.porDefecto)
    ? ''
    : ` · ⚠ '${d.porDefecto}' NO está montado: los cobros nuevos van a fallar`;
  return `URBONT PAYMENTS v${d.version} escuchando en :${d.puerto} · procesador por defecto: ${d.porDefecto} · montados: ${montados}${aviso}`;
}
