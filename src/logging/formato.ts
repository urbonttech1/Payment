/**
 * De una línea de `pino` (JSON) a una línea que se lee de un vistazo.
 *
 *     2026-11-12 21:04:01  ERROR  POST /internal/cards → 502  473ms  (req a1b2c3d4)
 *     2026-11-12 21:04:01  ERROR  [ErroresDePagoFilter] POST /internal/cards → 502 PROVIDER_FAILED: …
 *     2026-11-12 21:02:00  INFO   [ProviderRegistry] Procesador 'square' reemplazado en caliente.
 *
 * Existe porque `pino` escribe JSON, y el JSON es para máquinas: cada petición
 * ocupaba ocho líneas de cabeceras que nadie lee, las sondas del balanceador
 * llenaban el registro cada pocos segundos, y la causa de un 502 estaba enterrada
 * entre un *stack* que no decía nada. `pino-pretty` resolvería la forma, pero es
 * una dependencia de desarrollo y no está en la imagen de producción.
 *
 * Es una función **pura** —texto entra, texto sale— para poder probarla con las
 * líneas reales de producción. La hora va en UTC, que es la de CloudWatch.
 *
 * Nada de esto es la única salida: con `LOG_FORMAT=json` el servicio escribe el
 * JSON tal cual, para quien alimente una herramienta de análisis.
 */

export interface OpcionesDeFormato {
  /** Colores ANSI. Sólo tienen sentido en una terminal: CloudWatch los enseñaría como basura. */
  color: boolean;
  /** Cuántas líneas de *stack* se enseñan, como mucho. */
  marcos: number;
  /** Enseña también el ruido de arranque de Nest (cada ruta que registra). */
  verboso: boolean;
}

const POR_DEFECTO: OpcionesDeFormato = { color: false, marcos: 4, verboso: false };

/** Lo que Nest cuenta al arrancar: una línea por cada ruta y cada módulo. Más de sesenta, y no dicen nada. */
const CONTEXTOS_DE_ARRANQUE = new Set(['InstanceLoader', 'RoutesResolver', 'RouterExplorer']);

/** Campos que `pino` pone en cada línea y que ya van en otro sitio, o no aportan. */
const CAMPOS_PROPIOS = new Set(['level', 'time', 'pid', 'hostname', 'service', 'context', 'msg', 'req', 'res', 'err', 'responseTime', 'v', 'name']);

/** Si un campo se llama así, su valor no se enseña: es una credencial, aunque alguien la haya puesto en el registro por descuido. */
const CAMPO_SENSIBLE = /secret|token|authorization|password|passwd|signature|cookie|api[-_]?key|credential/i;

const MAX_VALOR = 120;

const ANSI = {
  reset: '\x1b[0m', tenue: '\x1b[2m', negrita: '\x1b[1m',
  rojo: '\x1b[31m', verde: '\x1b[32m', amarillo: '\x1b[33m', cian: '\x1b[36m',
} as const;

const NIVELES: Record<number, { etiqueta: string; color: string }> = {
  10: { etiqueta: 'TRACE', color: ANSI.tenue },
  20: { etiqueta: 'DEBUG', color: ANSI.tenue },
  30: { etiqueta: 'INFO ', color: ANSI.cian },
  40: { etiqueta: 'WARN ', color: ANSI.amarillo },
  50: { etiqueta: 'ERROR', color: ANSI.rojo },
  60: { etiqueta: 'FATAL', color: ANSI.negrita + ANSI.rojo },
};

/** `1794517441089` → `2026-11-12 21:04:01`, en UTC. */
export function horaLegible(tiempo: unknown): string {
  const d = new Date(typeof tiempo === 'number' || typeof tiempo === 'string' ? tiempo : NaN);
  return Number.isNaN(d.getTime()) ? '????-??-?? ??:??:??' : d.toISOString().slice(0, 19).replace('T', ' ');
}

function pintar(texto: string, color: string, o: OpcionesDeFormato): string {
  return o.color ? `${color}${texto}${ANSI.reset}` : texto;
}

function colorDeEstado(estado: number): string {
  if (estado >= 500) return ANSI.rojo;
  if (estado >= 400) return ANSI.amarillo;
  return ANSI.verde;
}

/** Un valor suelto, en una sola línea y sin pasarse de largo. */
function enTexto(v: unknown): string {
  let t: string;
  if (typeof v === 'string') t = /[\s"=]/.test(v) ? JSON.stringify(v) : v;
  else if (v === null || v === undefined) t = String(v);
  else if (typeof v === 'object') {
    try { t = JSON.stringify(v); } catch { t = '[objeto]'; }
  } else t = String(v);
  return t.length > MAX_VALOR ? `${t.slice(0, MAX_VALOR - 1)}…` : t;
}

function camposExtra(r: Record<string, unknown>): string {
  const partes: string[] = [];
  for (const [k, v] of Object.entries(r)) {
    if (CAMPOS_PROPIOS.has(k) || v === undefined) continue;
    partes.push(`${k}=${CAMPO_SENSIBLE.test(k) ? '[oculto]' : enTexto(v)}`);
  }
  return partes.length ? `  ${partes.join(' ')}` : '';
}

/**
 * Las líneas que siguen a la primera de un mensaje —casi siempre un *stack*—,
 * reducidas a lo que sirve.
 *
 * Un *stack* de Node son quince líneas y la mitad son `node_modules` y
 * `node:internal`, que nunca son la causa. Se enseñan las del propio código, hasta
 * `marcos`, y se dice cuántas se callan. Si ninguna es del propio código se
 * enseñan las primeras tal cual: callar todo también es perder la pista.
 */
function continuaciones(lineas: string[], o: OpcionesDeFormato): string[] {
  const limpias = lineas.map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
  if (limpias.length === 0) return [];

  const propias = limpias.filter((l) => !/node_modules|node:internal/.test(l));
  const elegidas = (propias.length > 0 ? propias : limpias).slice(0, o.marcos);
  const callan = limpias.length - elegidas.length;

  const salida = elegidas.map((l) => `    ${l.trim()}`);
  if (callan > 0) salida.push(pintar(`    … (+${callan} líneas más)`, ANSI.tenue, o));
  return salida;
}

function esFrame(linea: string): boolean {
  return /^\s*at\s/.test(linea);
}

/**
 * Convierte una línea de `pino` en una línea humana, o `null` si no hay que
 * enseñarla. Lo que no es JSON se devuelve tal cual: un `console.error` suelto, o
 * lo que escriba una librería, no se pierde.
 */
export function formatearLinea(linea: string, opciones: Partial<OpcionesDeFormato> = {}): string | null {
  const o: OpcionesDeFormato = { ...POR_DEFECTO, ...opciones };

  const texto = linea.trimEnd();
  if (texto === '') return null;

  let r: Record<string, unknown>;
  try {
    const parseado: unknown = JSON.parse(texto);
    if (parseado === null || typeof parseado !== 'object' || Array.isArray(parseado)) return texto;
    r = parseado as Record<string, unknown>;
  } catch {
    return texto;
  }

  const nivelNumero = typeof r.level === 'number' ? r.level : 30;
  const nivel = NIVELES[nivelNumero] ?? NIVELES[30];
  const contexto = typeof r.context === 'string' ? r.context : undefined;

  // El ruido de arranque de Nest: sólo se enseña si se pide, o si es un aviso o un error.
  if (!o.verboso && contexto && CONTEXTOS_DE_ARRANQUE.has(contexto) && nivelNumero < 40) return null;

  const hora = pintar(horaLegible(r.time), ANSI.tenue, o);
  const etiqueta = pintar(nivel.etiqueta, nivel.color, o);
  const cabecera = `${hora}  ${etiqueta}  `;

  const req = r.req as { method?: unknown; url?: unknown; id?: unknown } | undefined;
  const res = r.res as { statusCode?: unknown } | undefined;

  // ── Una petición HTTP: método, ruta, estado y duración. Nada más. ──────────
  if (req && typeof req === 'object' && typeof req.method === 'string' && res && typeof res.statusCode === 'number') {
    const ms = typeof r.responseTime === 'number' ? `  ${Math.round(r.responseTime)}ms` : '';
    const id = req.id !== undefined && req.id !== null ? `  ${pintar(`(req ${String(req.id)})`, ANSI.tenue, o)}` : '';
    const estado = pintar(String(res.statusCode), colorDeEstado(res.statusCode), o);
    return `${cabecera}${req.method} ${String(req.url ?? '')} → ${estado}${ms}${id}${camposExtra(r)}`;
  }

  // ── Todo lo demás: [contexto] mensaje, con lo que traiga de más. ───────────
  const msg = typeof r.msg === 'string' ? r.msg : '';
  const [primera = '', ...resto] = msg.split('\n');
  const prefijo = contexto ? `${pintar(`[${contexto}]`, ANSI.tenue, o)} ` : '';

  const err = r.err as { type?: unknown; message?: unknown; stack?: unknown } | undefined;
  let detalle = '';
  let stack: string[] = [];
  if (err && typeof err === 'object') {
    const mensaje = typeof err.message === 'string' ? err.message : '';
    // Si el mensaje ya lo dice, no se repite.
    if (mensaje && !primera.includes(mensaje)) {
      detalle = ` — ${typeof err.type === 'string' ? `${err.type}: ` : ''}${mensaje}`;
    }
    if (typeof err.stack === 'string') stack = err.stack.split('\n').filter(esFrame);
  }

  const lineas = [`${cabecera}${prefijo}${primera}${detalle}${camposExtra(r)}`];
  lineas.push(...continuaciones([...resto, ...stack], o));
  return lineas.join('\n');
}

/**
 * Las opciones según el entorno: colores sólo en una terminal y sin `NO_COLOR`;
 * y el ruido de arranque sólo con `LOG_LEVEL=debug` o `trace`.
 */
export function opcionesDeFormato(env: NodeJS.ProcessEnv, esTerminal: boolean): OpcionesDeFormato {
  const nivel = (env.LOG_LEVEL ?? 'info').toLowerCase();
  const quiereColor = env.LOG_COLOR === 'true' || (env.LOG_COLOR !== 'false' && esTerminal && !env.NO_COLOR);
  return {
    color: quiereColor,
    marcos: Math.max(0, Number(env.LOG_STACK_FRAMES ?? POR_DEFECTO.marcos) || POR_DEFECTO.marcos),
    verboso: nivel === 'debug' || nivel === 'trace',
  };
}
