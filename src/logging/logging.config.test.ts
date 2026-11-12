import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pinoHttp from 'pino-http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configuracionDeLogs,
  crearDestino,
  esSonda,
  idDePeticion,
  nivelDePeticion,
  opcionesDeHttp,
} from './logging.config';

describe('las sondas del balanceador', () => {
  it('se reconocen, con o sin query', () => {
    expect(esSonda('/healthz')).toBe(true);
    expect(esSonda('/readyz')).toBe(true);
    expect(esSonda('/healthz?x=1')).toBe(true);
  });

  it('el resto no', () => {
    expect(esSonda('/internal/charges')).toBe(false);
    expect(esSonda('/healthz/otra')).toBe(false);
    expect(esSonda(undefined)).toBe(false);
  });
});

describe('nivelDePeticion', () => {
  it('UNA SONDA QUE VA BIEN NO SE REGISTRA', () => {
    expect(nivelDePeticion('/healthz', 200, undefined, {})).toBe('silent');
    expect(nivelDePeticion('/readyz', 200, undefined, {})).toBe('silent');
  });

  // Un servicio que se declara enfermo es lo primero que hay que ver.
  it('PERO UNA SONDA QUE FALLA SÍ', () => {
    expect(nivelDePeticion('/healthz', 503, undefined, {})).toBe('error');
    expect(nivelDePeticion('/healthz', 200, new Error('x'), {})).toBe('error');
  });

  it('LOG_HEALTHCHECKS=true las vuelve a enseñar', () => {
    expect(nivelDePeticion('/healthz', 200, undefined, { LOG_HEALTHCHECKS: 'true' })).toBe('info');
  });

  it('una petición normal: info, aviso o error según cómo terminó', () => {
    expect(nivelDePeticion('/internal/charges', 200, undefined, {})).toBe('info');
    expect(nivelDePeticion('/internal/charges', 201, undefined, {})).toBe('info');
    expect(nivelDePeticion('/internal/charges', 404, undefined, {})).toBe('warn');
    expect(nivelDePeticion('/internal/charges', 402, undefined, {})).toBe('warn');
    expect(nivelDePeticion('/internal/charges', 502, undefined, {})).toBe('error');
    expect(nivelDePeticion('/internal/charges', 200, new Error('x'), {})).toBe('error');
  });
});

describe('idDePeticion', () => {
  it('respeta el x-request-id de quien llama', () => {
    expect(idDePeticion({ headers: { 'x-request-id': 'abc-123' } })).toBe('abc-123');
  });

  // El contador por defecto de pino-http empieza de cero en cada tarea: con dos
  // detrás del balanceador, la petición «108» serían dos peticiones distintas.
  it('si no, uno aleatorio y corto, distinto cada vez', () => {
    const ids = new Set(Array.from({ length: 500 }, () => idDePeticion({ headers: {} })));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('no se fía de un x-request-id con basura: no se mete en el registro', () => {
    expect(idDePeticion({ headers: { 'x-request-id': 'a b\nc' } })).toMatch(/^[0-9a-f]{8}$/);
    expect(idDePeticion({ headers: { 'x-request-id': 'x'.repeat(200) } })).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('los serializadores', () => {
  const o = opcionesDeHttp({});
  const reqSerializer = (o.serializers as { req: (r: unknown) => unknown }).req;
  const resSerializer = (o.serializers as { res: (r: unknown) => unknown }).res;

  it('LA PETICIÓN SE QUEDA EN TRES CAMPOS: NI UNA CABECERA', () => {
    const serializada = reqSerializer({
      id: 'ab', method: 'POST', url: '/internal/cards',
      headers: { 'x-urbont-signature': 'sha256=secreto', authorization: 'Bearer x', cookie: 'a=b' },
      remoteAddress: '1.2.3.4',
    });
    expect(serializada).toEqual({ id: 'ab', method: 'POST', url: '/internal/cards' });
    expect(JSON.stringify(serializada)).not.toContain('secreto');
  });

  it('la respuesta, sólo el estado', () => {
    expect(resSerializer({ statusCode: 502, headers: { 'set-cookie': 'x' } })).toEqual({ statusCode: 502 });
  });

  it('mantiene la lista de redacción, por si un día vuelven las cabeceras', () => {
    expect(o.redact).toContain('req.headers["x-urbont-signature"]');
  });

  it('el nivel viene de LOG_LEVEL, y por defecto es info', () => {
    expect(opcionesDeHttp({ LOG_LEVEL: 'debug' }).level).toBe('debug');
    expect(opcionesDeHttp({}).level).toBe('info');
  });
});

describe('crearDestino', () => {
  const salida = () => {
    const lineas: string[] = [];
    return { lineas, write: (t: string) => { lineas.push(t); return true; }, isTTY: false };
  };

  it('LOG_FORMAT=json devuelve undefined: pino escribe su JSON de siempre', () => {
    expect(crearDestino({ LOG_FORMAT: 'json' }, salida())).toBeUndefined();
    expect(crearDestino({ LOG_FORMAT: 'JSON' }, salida())).toBeUndefined();
  });

  it('por defecto da un destino que formatea', () => {
    const s = salida();
    const d = crearDestino({}, s)!;
    d.write(JSON.stringify({ level: 30, time: 1794517441089, context: 'X', msg: 'hola' }) + '\n');
    expect(s.lineas).toEqual(['2026-11-12 21:04:01  INFO   [X] hola\n']);
  });

  it('lo que el formateador descarta no se escribe', () => {
    const s = salida();
    crearDestino({}, s)!.write(JSON.stringify({ level: 30, context: 'RouterExplorer', msg: 'Mapped' }));
    expect(s.lineas).toEqual([]);
  });

  it('un valor desconocido de LOG_FORMAT cae al texto legible, no al JSON', () => {
    expect(crearDestino({ LOG_FORMAT: 'raro' }, salida())).toBeDefined();
  });
});

describe('configuracionDeLogs', () => {
  it('por defecto: opciones y destino', () => {
    const c = configuracionDeLogs({});
    expect(Array.isArray(c)).toBe(true);
  });

  it('con LOG_FORMAT=json: sólo opciones, sin destino propio', () => {
    expect(Array.isArray(configuracionDeLogs({ LOG_FORMAT: 'json' }))).toBe(false);
  });
});

describe('de punta a punta: un servidor HTTP de verdad', () => {
  let servidor: Server | undefined;
  afterEach(() => new Promise<void>((r) => (servidor ? servidor.close(() => r()) : r())));

  /** Levanta un servidor con pino-http configurado como el servicio y devuelve lo que escribió. */
  async function levantar(env: NodeJS.ProcessEnv, estadoDe: (url: string) => number) {
    const escrito: string[] = [];
    const destino = crearDestino(env, { write: (t: string) => { escrito.push(t); return true; }, isTTY: false })!;
    const registrar = pinoHttp(opcionesDeHttp(env), destino as never);
    servidor = createServer((req, res) => {
      registrar(req, res);
      res.statusCode = estadoDe(req.url ?? '');
      res.end('ok');
    });
    await new Promise<void>((r) => servidor!.listen(0, '127.0.0.1', r));
    const { port } = servidor.address() as AddressInfo;
    const pedir = (ruta: string, cabeceras: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${port}${ruta}`, { headers: cabeceras }).then((r) => r.text());
    return { escrito, pedir };
  }

  it('una petición real sale como una línea legible, sin cabeceras', async () => {
    const { escrito, pedir } = await levantar({}, () => 200);
    await pedir('/internal/charges/x', { 'x-urbont-signature': 'sha256=secreto', authorization: 'Bearer z', 'x-request-id': 'req-77' });
    await new Promise((r) => setTimeout(r, 30));

    expect(escrito).toHaveLength(1);
    expect(escrito[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}  INFO   GET \/internal\/charges\/x → 200  \d+ms  \(req req-77\)\n$/);
    expect(escrito[0]).not.toContain('secreto');
    expect(escrito[0]).not.toContain('Bearer');
  });

  it('LAS SONDAS BUENAS NO ESCRIBEN NADA; UNA QUE FALLA SÍ', async () => {
    let enfermo = false;
    const { escrito, pedir } = await levantar({}, (url) => (url === '/healthz' && enfermo ? 503 : 200));
    for (let i = 0; i < 5; i++) await pedir('/healthz');
    await pedir('/readyz');
    await new Promise((r) => setTimeout(r, 30));
    expect(escrito).toHaveLength(0);

    enfermo = true;
    await pedir('/healthz');
    await new Promise((r) => setTimeout(r, 30));
    expect(escrito).toHaveLength(1);
    expect(escrito[0]).toContain('ERROR');
    expect(escrito[0]).toContain('GET /healthz → 503');
  });

  it('un 404 es un aviso y un 502 es un error', async () => {
    const { escrito, pedir } = await levantar({}, (url) => (url === '/a' ? 404 : 502));
    await pedir('/a');
    await pedir('/b');
    await new Promise((r) => setTimeout(r, 30));
    expect(escrito[0]).toContain('WARN');
    expect(escrito[0]).toContain('/a → 404');
    expect(escrito[1]).toContain('ERROR');
    expect(escrito[1]).toContain('/b → 502');
  });

  it('con LOG_HEALTHCHECKS=true las sondas sí salen', async () => {
    const { escrito, pedir } = await levantar({ LOG_HEALTHCHECKS: 'true' }, () => 200);
    await pedir('/healthz');
    await new Promise((r) => setTimeout(r, 30));
    expect(escrito).toHaveLength(1);
  });
});
