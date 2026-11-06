/**
 * La firma de las llamadas entre `urbont-api` y este servicio.
 *
 * El micro no es alcanzable desde la app, pero sí desde el balanceador, así que
 * lo que de verdad lo protege es esta firma y no la red. Por eso vive en un
 * archivo propio, puro y probado: es la cerradura.
 *
 * El canon —y hay que decirlo exacto, porque al otro lado hay una copia de esto
 * en `urbont-api/server/services/payments/firma.ts`— es:
 *
 *     mensaje = `${ts}.${MÉTODO}.${ruta}.${sha256hex(cuerpoCrudo)}`
 *     firma   = `sha256=${hmacSha256hex(secreto, mensaje)}`
 *
 * Tres cosas que no son evidentes y que son el motivo de que el canon sea así:
 *
 *  · **Va el método y la ruta**, no sólo el cuerpo. Sin ellos, una firma válida
 *    para `/capture` serviría tal cual para `/refund`.
 *  · **Va el hash del cuerpo, no el cuerpo**, para no construir un mensaje de
 *    megabytes ni arrastrarlo por el registro.
 *  · **Va la hora, y se exige fresca.** Un reenvío dentro de la ventana es
 *    inofensivo —toda operación que mueve dinero es idempotente por clave—,
 *    pero una firma capturada hace un mes no debería valer nunca.
 *
 * Los dos archivos comparten además los mismos vectores de prueba escritos a
 * mano. Si alguien cambia el canon en un lado, se rompe una prueba en el otro,
 * que es exactamente donde queremos que se rompa.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const CABECERA_TS = 'x-urbont-timestamp';
export const CABECERA_FIRMA = 'x-urbont-signature';
export const CABECERA_CLAVE = 'idempotency-key';

/** Cuánto puede desviarse el reloj del que llama antes de rechazarlo. */
export const VENTANA_MS = 5 * 60_000;

export interface PeticionFirmable {
  /** `POST`, `GET`… Se normaliza a mayúsculas. */
  metodo: string;
  /** La ruta con su query, tal cual: `/internal/charges/ride_abc_authorize/capture`. */
  ruta: string;
  /** El cuerpo CRUDO, antes de parsear. Vacío para un GET. */
  cuerpo: string | Buffer;
  /** Epoch en milisegundos. */
  ts: number;
}

export function mensajeAFirmar(p: PeticionFirmable): string {
  const hashCuerpo = createHash('sha256').update(p.cuerpo ?? '').digest('hex');
  return `${p.ts}.${p.metodo.toUpperCase()}.${p.ruta}.${hashCuerpo}`;
}

export function firmar(p: PeticionFirmable, secreto: string): string {
  const hmac = createHmac('sha256', secreto).update(mensajeAFirmar(p)).digest('hex');
  return `sha256=${hmac}`;
}

export type Veredicto = { ok: true } | { ok: false; motivo: string };

/**
 * Comprueba la firma.
 *
 * El motivo se devuelve para el registro, nunca para el cuerpo de la respuesta:
 * decirle a quien llama *por qué* falló su firma es ayudarle a acertar.
 */
export function verificar(
  p: PeticionFirmable,
  secreto: string,
  firmaRecibida: string | undefined,
  ahora: number = Date.now(),
): Veredicto {
  if (!secreto) return { ok: false, motivo: 'el servicio no tiene secreto configurado' };
  if (!firmaRecibida) return { ok: false, motivo: `falta la cabecera ${CABECERA_FIRMA}` };
  if (!Number.isFinite(p.ts)) return { ok: false, motivo: `la cabecera ${CABECERA_TS} no es un número` };

  const desvio = Math.abs(ahora - p.ts);
  if (desvio > VENTANA_MS) {
    return { ok: false, motivo: `la petición viene con ${Math.round(desvio / 1000)} s de desvío` };
  }

  const esperada = firmar(p, secreto);
  // Longitudes distintas rompen `timingSafeEqual`, así que se descarta antes.
  if (esperada.length !== firmaRecibida.length) return { ok: false, motivo: 'la firma no cuadra' };
  const iguales = timingSafeEqual(Buffer.from(esperada), Buffer.from(firmaRecibida));
  return iguales ? { ok: true } : { ok: false, motivo: 'la firma no cuadra' };
}

/** Las cabeceras que hay que mandar. Útil también para el cliente de pruebas. */
export function cabecerasDeFirma(
  p: Omit<PeticionFirmable, 'ts'> & { ts?: number },
  secreto: string,
): Record<string, string> {
  const ts = p.ts ?? Date.now();
  return {
    [CABECERA_TS]: String(ts),
    [CABECERA_FIRMA]: firmar({ ...p, ts }, secreto),
  };
}
