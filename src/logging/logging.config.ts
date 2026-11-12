/**
 * Cómo se registra el servicio: qué se escribe, con qué forma y a dónde.
 *
 * Tres decisiones, cada una contra un ruido concreto que había en producción:
 *
 *  1. **Las sondas no se registran.** El balanceador pregunta a `/healthz` cada
 *     pocos segundos desde cada tarea; eran casi todas las líneas del registro y
 *     ninguna decía nada. Se siguen registrando si fallan —un 503 en `/healthz` es
 *     justo lo que hay que ver— y se pueden activar con `LOG_HEALTHCHECKS=true`.
 *  2. **Una petición es una línea con cuatro datos** —método, ruta, estado y
 *     duración—, no las ~20 cabeceras que `pino-http` volcaba por defecto. Las
 *     cabeceras no se necesitan para diagnosticar y alguna llevaba una firma.
 *  3. **Se escribe texto legible, no JSON.** `LOG_FORMAT=json` devuelve el JSON tal
 *     cual para quien alimente una herramienta de análisis.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Options } from 'pino-http';
import { formatearLinea, opcionesDeFormato } from './formato';

/** Rutas que sondea el balanceador y ECS. */
const RUTAS_DE_SONDA = new Set(['/healthz', '/readyz']);

/** Algo a lo que `pino` pueda escribir una línea. */
export interface DestinoDeLogs {
  write(linea: string): void;
}

export function esSonda(url: string | undefined): boolean {
  if (!url) return false;
  const ruta = url.split('?')[0];
  return RUTAS_DE_SONDA.has(ruta);
}

type Nivel = 'silent' | 'info' | 'warn' | 'error';

/**
 * El nivel de la línea de una petición, según cómo terminó.
 *
 * Una sonda que va bien es `silent`; una sonda que falla NO, porque un servicio
 * que se declara enfermo es lo primero que hay que ver.
 */
export function nivelDePeticion(
  url: string | undefined,
  estado: number,
  error: Error | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Nivel {
  const fallo = estado >= 500 || Boolean(error);
  if (!fallo && estado < 400 && esSonda(url) && env.LOG_HEALTHCHECKS !== 'true') return 'silent';
  if (fallo) return 'error';
  if (estado >= 400) return 'warn';
  return 'info';
}

/**
 * Un identificador corto por petición, para poder juntar sus líneas.
 *
 * Se respeta el `x-request-id` si quien llama lo manda. Si no, uno aleatorio de
 * ocho caracteres: el contador por defecto de `pino-http` (1, 2, 3…) empieza de cero
 * en CADA tarea, y con dos tareas detrás del balanceador la petición «108» sería
 * dos peticiones distintas.
 */
export function idDePeticion(req: Pick<IncomingMessage, 'headers'>): string {
  const dado = req.headers?.['x-request-id'];
  const valor = Array.isArray(dado) ? dado[0] : dado;
  if (typeof valor === 'string' && /^[\w.-]{1,64}$/.test(valor)) return valor;
  return randomUUID().slice(0, 8);
}

/**
 * Las opciones de `pino-http`.
 *
 * Los serializadores de `req` y `res` dejan sólo lo que se enseña. Así las
 * cabeceras —y con ellas la firma de las llamadas entre servicios— ni siquiera
 * llegan a la línea: no hace falta confiar en que alguien se acuerde de
 * redactarlas. La lista de `redact` se mantiene igualmente, por si un día alguien
 * vuelve a poner las cabeceras.
 */
export function opcionesDeHttp(env: NodeJS.ProcessEnv = process.env): Options {
  return {
    level: env.LOG_LEVEL ?? 'info',
    base: { service: 'urbont-payments' },
    redact: ['req.headers.authorization', 'req.headers["x-urbont-signature"]', 'req.headers["stripe-signature"]'],

    genReqId: (req: IncomingMessage) => idDePeticion(req),

    serializers: {
      req: (req: { id?: unknown; method?: string; url?: string }) => ({ id: req.id, method: req.method, url: req.url }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
    },

    customLogLevel: (req: IncomingMessage, res: ServerResponse, error?: Error) =>
      nivelDePeticion(req.url, res.statusCode, error, env),

    // Para quien use LOG_FORMAT=json: el mensaje ya dice lo importante.
    customSuccessMessage: (req: IncomingMessage, res: ServerResponse) => `${req.method} ${req.url} → ${res.statusCode}`,
    customErrorMessage: (req: IncomingMessage, res: ServerResponse) => `${req.method} ${req.url} → ${res.statusCode}`,
  };
}

/**
 * A dónde se escribe. `undefined` es la salida estándar de `pino`, en JSON.
 *
 * Es lo que se devuelve con `LOG_FORMAT=json`. Con cualquier otro valor se
 * devuelve un destino que formatea cada línea antes de escribirla.
 */
export function crearDestino(
  env: NodeJS.ProcessEnv = process.env,
  salida: { write(texto: string): unknown; isTTY?: boolean } = process.stdout,
): DestinoDeLogs | undefined {
  if ((env.LOG_FORMAT ?? 'pretty').toLowerCase() === 'json') return undefined;

  const opciones = opcionesDeFormato(env, Boolean(salida.isTTY));
  return {
    write(linea: string): void {
      const texto = formatearLinea(linea, opciones);
      if (texto !== null) salida.write(`${texto}\n`);
    },
  };
}

/** Lo que recibe `LoggerModule.forRoot({ pinoHttp })`. */
export function configuracionDeLogs(env: NodeJS.ProcessEnv = process.env): Options | [Options, DestinoDeLogs] {
  const opciones = opcionesDeHttp(env);
  const destino = crearDestino(env);
  return destino ? [opciones, destino] : opciones;
}
