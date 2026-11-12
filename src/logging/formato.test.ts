import { describe, expect, it } from 'vitest';
import { formatearLinea, horaLegible, opcionesDeFormato } from './formato';

const linea = (o: Record<string, unknown>) => JSON.stringify({ level: 30, time: 1794517441089, service: 'urbont-payments', ...o });

/**
 * La línea REAL de producción que motivó esto —la de un 502 en `POST /internal/cards`—,
 * con las direcciones IP cambiadas y el *stack* recortado a dos líneas (el de verdad
 * eran nueve: la línea entera pasaba de 1.900 caracteres). Casi todo son cabeceras y
 * un *stack* de `pino-http` que no dice nada: lo único útil son cuatro datos.
 */
const PETICION_REAL = JSON.stringify({
  level: 30, time: 1794517441089, service: 'urbont-payments',
  req: {
    id: 108, method: 'POST', url: '/internal/cards', query: {}, params: { path: ['internal', 'cards'] },
    headers: {
      'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https', 'x-forwarded-port': '443',
      host: 'payments.urbont.com', 'x-amzn-trace-id': 'Root=1-6af629c0-159c674d78e758203ca1a1a1',
      'content-length': '180', 'x-urbont-timestamp': '1794517440602', 'x-urbont-signature': '[Redacted]',
      'content-type': 'application/json', accept: '*/*', 'accept-language': '*', 'sec-fetch-mode': 'cors',
      'user-agent': 'node', 'accept-encoding': 'br, gzip, deflate',
    },
    remoteAddress: '172.31.48.64', remotePort: 24656,
  },
  res: { statusCode: 502, headers: { 'x-powered-by': 'Express', 'content-type': 'application/json; charset=utf-8', 'content-length': '27' } },
  err: {
    type: 'Error', message: 'failed with status code 502',
    stack: 'Error: failed with status code 502\n    at onResFinished (/app/node_modules/.pnpm/pino-http@10.5.0/node_modules/pino-http/logger.js:115:39)\n    at ServerResponse.onResponseComplete (/app/node_modules/.pnpm/pino-http@10.5.0/node_modules/pino-http/logger.js:178:14)',
  },
  responseTime: 473, msg: 'request errored',
});

describe('una petición HTTP', () => {
  // De 1.900 caracteres a una línea: método, ruta, estado y duración.
  it('LA LÍNEA REAL DE PRODUCCIÓN SE REDUCE A LO QUE IMPORTA', () => {
    const salida = formatearLinea(PETICION_REAL)!;
    expect(salida).toBe('2026-11-12 21:04:01  INFO   POST /internal/cards → 502  473ms  (req 108)');
    expect(PETICION_REAL.length).toBeGreaterThan(1000);
    expect(salida.length).toBeLessThan(100);
  });

  it('no deja pasar ni una cabecera, ni el stack genérico de pino-http', () => {
    const salida = formatearLinea(PETICION_REAL)!;
    for (const basura of ['x-forwarded', 'user-agent', 'x-urbont-signature', 'accept-encoding', 'onResFinished', 'node_modules', 'failed with status code']) {
      expect(salida).not.toContain(basura);
    }
    expect(salida.split('\n')).toHaveLength(1);
  });

  it('una petición buena', () => {
    const salida = formatearLinea(linea({ req: { id: 'ab12cd34', method: 'GET', url: '/internal/charges/ride_x_authorize' }, res: { statusCode: 200 }, responseTime: 12.4 }))!;
    expect(salida).toBe('2026-11-12 21:04:01  INFO   GET /internal/charges/ride_x_authorize → 200  12ms  (req ab12cd34)');
  });

  it('sin duración o sin id, no inventa nada ni deja huecos raros', () => {
    expect(formatearLinea(linea({ req: { method: 'GET', url: '/x' }, res: { statusCode: 404 } })))
      .toBe('2026-11-12 21:04:01  INFO   GET /x → 404');
  });
});

describe('lo que no es una petición', () => {
  it('[contexto] y mensaje', () => {
    expect(formatearLinea(linea({ context: 'ProviderRegistry', msg: "Procesador 'square' reemplazado en caliente." })))
      .toBe("2026-11-12 21:04:01  INFO   [ProviderRegistry] Procesador 'square' reemplazado en caliente.");
  });

  it('sin contexto, sólo el mensaje', () => {
    expect(formatearLinea(linea({ msg: '[MIGRACIONES] aplicada 005_pago_manual.sql' })))
      .toBe('2026-11-12 21:04:01  INFO   [MIGRACIONES] aplicada 005_pago_manual.sql');
  });

  it('los niveles se leen: INFO, WARN, ERROR, FATAL, DEBUG, TRACE', () => {
    const e = (n: number) => formatearLinea(linea({ level: n, msg: 'x' }))!.split('  ')[1].trim();
    expect([e(10), e(20), e(30), e(40), e(50), e(60)]).toEqual(['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']);
  });

  it('un nivel que no conoce se trata como INFO en vez de romperse', () => {
    expect(formatearLinea(linea({ level: 999, msg: 'x' }))).toContain('INFO');
  });
});

describe('los errores', () => {
  // El filtro de errores metía el stack ENTERO dentro del mensaje.
  it('un stack dentro del mensaje se reduce a las líneas del propio código', () => {
    const msg =
      'POST /internal/cards → 502 PROVIDER_FAILED: ProcesadorFalloError: Square falló\n' +
      '    at SquareProvider.traduciendoErrores (/app/dist/src/providers/square/square.provider.js:598:15)\n' +
      '    at async SquareProvider.saveCard (/app/dist/src/providers/square/square.provider.js:380:20)\n' +
      '    at async /app/node_modules/.pnpm/@nestjs+core@11/node_modules/@nestjs/core/router/router-execution-context.js:46:28\n' +
      '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)';
    const salida = formatearLinea(linea({ level: 50, context: 'ErroresDePagoFilter', msg }))!.split('\n');
    expect(salida[0]).toBe('2026-11-12 21:04:01  ERROR  [ErroresDePagoFilter] POST /internal/cards → 502 PROVIDER_FAILED: ProcesadorFalloError: Square falló');
    // la causa + dos líneas del propio código + «callo dos»: las de node_modules y node:internal
    expect(salida).toHaveLength(4);
    expect(salida[1]).toContain('traduciendoErrores');
    expect(salida[3]).toContain('… (+2 líneas más)');
    expect(salida.join('\n')).not.toContain('node_modules');
    expect(salida.join('\n')).not.toContain('node:internal');
  });

  it('dice cuántas líneas calla', () => {
    const frames = Array.from({ length: 12 }, (_, i) => `    at funcion${i} (/app/dist/src/x${i}.js:1:1)`).join('\n');
    const salida = formatearLinea(linea({ level: 50, msg: `falló\n${frames}` }), { marcos: 3 })!;
    expect(salida).toContain('… (+9 líneas más)');
    expect(salida.split('\n')).toHaveLength(1 + 3 + 1);
  });

  // Callar todo también es perder la pista.
  it('si NINGUNA línea es del propio código, enseña las primeras igualmente', () => {
    const msg = 'falló\n    at a (/app/node_modules/x/a.js:1:1)\n    at b (/app/node_modules/x/b.js:1:1)';
    const salida = formatearLinea(linea({ level: 50, msg }))!;
    expect(salida).toContain('at a');
  });

  it('un error de pino (err) añade su mensaje si el texto no lo dice ya', () => {
    const salida = formatearLinea(linea({ level: 50, msg: 'No se pudo cobrar', err: { type: 'TypeError', message: 'x is undefined', stack: '' } }))!;
    expect(salida).toContain('No se pudo cobrar — TypeError: x is undefined');
  });

  it('y no lo repite si ya está', () => {
    const salida = formatearLinea(linea({ level: 50, msg: 'falló: x is undefined', err: { type: 'TypeError', message: 'x is undefined' } }))!;
    expect(salida.match(/x is undefined/g)).toHaveLength(1);
  });

  it('con marcos=0 no enseña ni una línea de stack', () => {
    const salida = formatearLinea(linea({ level: 50, msg: 'falló\n    at a (/app/dist/x.js:1:1)' }), { marcos: 0 })!;
    expect(salida.split('\n')[0]).toContain('falló');
    expect(salida).not.toContain('at a');
  });
});

describe('el ruido de arranque de Nest', () => {
  const ruido = linea({ context: 'RouterExplorer', msg: 'Mapped {/internal/charges, POST} route' });

  it('NO SE ENSEÑA: son más de sesenta líneas que no dicen nada', () => {
    for (const c of ['RouterExplorer', 'RoutesResolver', 'InstanceLoader']) {
      expect(formatearLinea(linea({ context: c, msg: 'lo que sea' }))).toBeNull();
    }
  });

  it('se enseña si se pide (LOG_LEVEL=debug)', () => {
    expect(formatearLinea(ruido, { verboso: true })).toContain('Mapped {/internal/charges, POST} route');
  });

  it('pero un AVISO o un ERROR de esos contextos nunca se calla', () => {
    expect(formatearLinea(linea({ level: 40, context: 'InstanceLoader', msg: 'no se pudo resolver' }))).not.toBeNull();
    expect(formatearLinea(linea({ level: 50, context: 'RouterExplorer', msg: 'ruta duplicada' }))).not.toBeNull();
  });

  it('el resto de lo que cuenta Nest sí sale', () => {
    expect(formatearLinea(linea({ context: 'NestApplication', msg: 'Nest application successfully started' }))).not.toBeNull();
  });
});

describe('campos de más', () => {
  it('los que añade quien loguea se enseñan como clave=valor', () => {
    expect(formatearLinea(linea({ msg: 'Cobro autorizado', rideId: 'abc', cents: 11715 }))).toBe('2026-11-12 21:04:01  INFO   Cobro autorizado  rideId=abc cents=11715');
  });

  it('un texto con espacios va entre comillas, y uno largo se recorta', () => {
    expect(formatearLinea(linea({ msg: 'x', motivo: 'tarjeta rechazada' }))).toContain('motivo="tarjeta rechazada"');
    const salida = formatearLinea(linea({ msg: 'x', blob: 'a'.repeat(500) }))!;
    expect(salida.length).toBeLessThan(220);
    expect(salida).toContain('…');
  });

  it('un objeto va en una sola línea', () => {
    expect(formatearLinea(linea({ msg: 'x', datos: { a: 1, b: [2, 3] } }))).toContain('datos={"a":1,"b":[2,3]}');
  });

  // Defensa en profundidad: nadie debería loguear una credencial, pero si alguien lo
  // hace por descuido no tiene que salir en claro.
  it('NO ENSEÑA EL VALOR DE UN CAMPO QUE PARECE UNA CREDENCIAL', () => {
    const salida = formatearLinea(linea({ msg: 'x', apiKey: 'sk_live_abc', secretKey: 's', authorization: 'Bearer z', password: 'p', webhookSignature: 'w', tokenDeTarjeta: 't' }))!;
    for (const valor of ['sk_live_abc', 'Bearer z']) expect(salida).not.toContain(valor);
    expect(salida.match(/\[oculto\]/g)).toHaveLength(6);
  });

  it('los campos propios de pino no se repiten', () => {
    const salida = formatearLinea(linea({ msg: 'x', pid: 7, hostname: 'h', v: 1, name: 'n' }))!;
    expect(salida).toBe('2026-11-12 21:04:01  INFO   x');
  });
});

describe('lo que no es JSON no se pierde', () => {
  it('un texto suelto sale tal cual', () => {
    expect(formatearLinea('[FATAL] URBONT PAYMENTS no pudo arrancar: Configuración inválida')).toBe('[FATAL] URBONT PAYMENTS no pudo arrancar: Configuración inválida');
  });

  it('JSON roto, también', () => {
    expect(formatearLinea('{"level":30,"msg":"cortado')).toBe('{"level":30,"msg":"cortado');
  });

  it('un JSON que no es un objeto, también', () => {
    expect(formatearLinea('42')).toBe('42');
    expect(formatearLinea('[1,2]')).toBe('[1,2]');
    expect(formatearLinea('null')).toBe('null');
  });

  it('una línea vacía no se escribe', () => {
    expect(formatearLinea('')).toBeNull();
    expect(formatearLinea('  \n')).toBeNull();
  });

  it('el salto de línea final de pino no sobra', () => {
    expect(formatearLinea(`${linea({ msg: 'x' })}\n`)).not.toMatch(/\n$/);
  });
});

describe('la hora', () => {
  it('en UTC, que es la de CloudWatch', () => {
    expect(horaLegible(1794517441089)).toBe('2026-11-12 21:04:01');
    expect(horaLegible('2026-11-12T21:04:01.089Z')).toBe('2026-11-12 21:04:01');
  });

  it('una hora que no entiende no rompe la línea', () => {
    expect(horaLegible(undefined)).toBe('????-??-?? ??:??:??');
    expect(formatearLinea(JSON.stringify({ level: 30, msg: 'x' }))).toContain('????-??-?? ??:??:??');
  });
});

describe('los colores', () => {
  it('NO HAY ANSI POR DEFECTO: en CloudWatch saldría como basura', () => {
    expect(formatearLinea(PETICION_REAL)).not.toMatch(/\x1b/);
    expect(formatearLinea(linea({ level: 50, msg: 'x' }))).not.toMatch(/\x1b/);
  });

  it('con color, el estado 5xx va en rojo y el 2xx en verde', () => {
    const e502 = formatearLinea(PETICION_REAL, { color: true })!;
    expect(e502).toContain('\x1b[31m502\x1b[0m');
    const ok = formatearLinea(linea({ req: { method: 'GET', url: '/x' }, res: { statusCode: 200 } }), { color: true })!;
    expect(ok).toContain('\x1b[32m200\x1b[0m');
  });

  it('el texto sin los códigos es el mismo con color que sin él', () => {
    const sinAnsi = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, '');
    expect(sinAnsi(formatearLinea(PETICION_REAL, { color: true })!)).toBe(formatearLinea(PETICION_REAL)!);
  });
});

describe('opcionesDeFormato: según el entorno', () => {
  it('color sólo en una terminal', () => {
    expect(opcionesDeFormato({}, true).color).toBe(true);
    expect(opcionesDeFormato({}, false).color).toBe(false);
  });

  it('NO_COLOR lo apaga y LOG_COLOR lo fuerza', () => {
    expect(opcionesDeFormato({ NO_COLOR: '1' }, true).color).toBe(false);
    expect(opcionesDeFormato({ LOG_COLOR: 'false' }, true).color).toBe(false);
    expect(opcionesDeFormato({ LOG_COLOR: 'true' }, false).color).toBe(true);
  });

  it('el ruido de arranque sólo con debug o trace', () => {
    expect(opcionesDeFormato({ LOG_LEVEL: 'info' }, false).verboso).toBe(false);
    expect(opcionesDeFormato({}, false).verboso).toBe(false);
    expect(opcionesDeFormato({ LOG_LEVEL: 'debug' }, false).verboso).toBe(true);
    expect(opcionesDeFormato({ LOG_LEVEL: 'TRACE' }, false).verboso).toBe(true);
  });

  it('LOG_STACK_FRAMES, con un valor absurdo cae al de siempre', () => {
    expect(opcionesDeFormato({ LOG_STACK_FRAMES: '8' }, false).marcos).toBe(8);
    expect(opcionesDeFormato({ LOG_STACK_FRAMES: 'abc' }, false).marcos).toBe(4);
    expect(opcionesDeFormato({}, false).marcos).toBe(4);
  });
});
