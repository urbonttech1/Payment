/**
 * Los vectores de abajo están escritos a mano, no calculados por el propio
 * código, y el **mismo bloque** está copiado en
 * `urbont-api/server/services/payments/firma.test.ts`.
 *
 * Es a propósito: son dos repositorios y el canon de la firma está duplicado.
 * Con vectores fijos, cambiar el canon en un lado rompe una prueba en los dos;
 * con vectores calculados, los dos lados seguirían verdes y la llamada real
 * devolvería 401 en producción.
 */

import { describe, expect, it } from 'vitest';
import {
  VENTANA_MS,
  cabecerasDeFirma,
  firmar,
  mensajeAFirmar,
  verificar,
} from './firma';

const SECRETO = 'secreto-de-prueba-para-urbont';
const TS = 1762400000000;

const VECTORES = [
  {
    nombre: 'POST con cuerpo',
    p: { ts: TS, metodo: 'POST', ruta: '/internal/charges', cuerpo: '{"amountCents":11000}' },
    firma: 'sha256=30eb675a1485c4cee6dd6b121d18ac42a21d0f21fbf4138e2daa69d8656feef3',
  },
  {
    nombre: 'GET sin cuerpo',
    p: { ts: TS, metodo: 'GET', ruta: '/internal/charges/ride_abc_authorize', cuerpo: '' },
    firma: 'sha256=c4afe60951936862ac18e03d7c1ce41d1faefb4705af879e0886ea44a60453d5',
  },
  {
    nombre: 'captura',
    p: { ts: TS, metodo: 'POST', ruta: '/internal/charges/ride_abc_authorize/capture', cuerpo: '{"amountCents":12000}' },
    firma: 'sha256=31c5111d066f2c99a5d0e8c8673d15618b8e842f2e38430ab8c88472c56302e7',
  },
  {
    nombre: 'la misma petición un minuto después',
    p: { ts: TS + 60_000, metodo: 'POST', ruta: '/internal/charges', cuerpo: '{"amountCents":11000}' },
    firma: 'sha256=428d6eb6f1fb46cf406ab2b3b4b48ce021a8bf1685badb2cfcee0f10840d39b1',
  },
];

describe('firma entre servicios', () => {
  it.each(VECTORES)('firma $nombre igual que el vector fijo', ({ p, firma }) => {
    expect(firmar(p, SECRETO)).toBe(firma);
  });

  it.each(VECTORES)('verifica $nombre', ({ p, firma }) => {
    expect(verificar(p, SECRETO, firma, p.ts)).toEqual({ ok: true });
  });

  it('el mensaje lleva hora, método, ruta y el hash del cuerpo', () => {
    expect(mensajeAFirmar({ ts: TS, metodo: 'post', ruta: '/x', cuerpo: '' })).toBe(
      `${TS}.POST./x.e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
    );
  });

  it('un cuerpo manipulado invalida la firma', () => {
    const { p, firma } = VECTORES[0];
    const manipulada = { ...p, cuerpo: '{"amountCents":100}' };
    expect(verificar(manipulada, SECRETO, firma, p.ts).ok).toBe(false);
  });

  it('la firma de una ruta no sirve para otra', () => {
    const { p, firma } = VECTORES[1];
    const otraRuta = { ...p, ruta: '/internal/charges/ride_otro_authorize' };
    expect(verificar(otraRuta, SECRETO, firma, p.ts).ok).toBe(false);
  });

  it('la firma de capturar no sirve para reembolsar', () => {
    const { p, firma } = VECTORES[2];
    const reembolso = { ...p, ruta: p.ruta.replace('/capture', '/refund') };
    expect(verificar(reembolso, SECRETO, firma, p.ts).ok).toBe(false);
  });

  it('otro secreto no vale', () => {
    const { p, firma } = VECTORES[0];
    expect(verificar(p, 'otro-secreto-cualquiera-largo', firma, p.ts).ok).toBe(false);
  });

  it('una firma caducada se rechaza aunque sea correcta', () => {
    const { p, firma } = VECTORES[0];
    const v = verificar(p, SECRETO, firma, p.ts + VENTANA_MS + 1);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.motivo).toMatch(/desvío/);
  });

  it('acepta el reloj adelantado dentro de la ventana', () => {
    const { p, firma } = VECTORES[0];
    expect(verificar(p, SECRETO, firma, p.ts - VENTANA_MS + 1000).ok).toBe(true);
  });

  it('sin firma, sin secreto o con hora ilegible, no pasa', () => {
    const { p, firma } = VECTORES[0];
    expect(verificar(p, SECRETO, undefined, p.ts).ok).toBe(false);
    expect(verificar(p, '', firma, p.ts).ok).toBe(false);
    expect(verificar({ ...p, ts: NaN }, SECRETO, firma, p.ts).ok).toBe(false);
  });

  it('una firma de otra longitud no revienta la comparación', () => {
    const { p } = VECTORES[0];
    expect(verificar(p, SECRETO, 'sha256=corta', p.ts).ok).toBe(false);
  });

  it('el cuerpo da igual si es Buffer o cadena', () => {
    const { p, firma } = VECTORES[0];
    expect(firmar({ ...p, cuerpo: Buffer.from(p.cuerpo) }, SECRETO)).toBe(firma);
  });

  it('las cabeceras que genera son las que el guardia verifica', () => {
    const p = { metodo: 'POST', ruta: '/internal/charges', cuerpo: '{}', ts: TS };
    const c = cabecerasDeFirma(p, SECRETO);
    expect(c['x-urbont-timestamp']).toBe(String(TS));
    expect(verificar(p, SECRETO, c['x-urbont-signature'], TS)).toEqual({ ok: true });
  });
});
