import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  CifradoCorruptoError, SinClaveMaestraError,
  cifrar, claveMaestra, descifrar, hayClaveMaestra, pista,
} from './cifrado';

const CLAVE = randomBytes(32);
const SECRETO = 'CREDENCIAL-DE-EJEMPLO-que-no-se-parece-a-la-de-nadie';

describe('la clave maestra', () => {
  it('acepta hex y base64, que es como la va a pegar quien la genere', () => {
    expect(claveMaestra(CLAVE.toString('hex'))).toEqual(CLAVE);
    expect(claveMaestra(CLAVE.toString('base64'))).toEqual(CLAVE);
  });

  // Rechazarla al arrancar, no cuando alguien intente guardar una credencial.
  it('rechaza lo que no mida 32 bytes', () => {
    expect(() => claveMaestra('corta')).toThrow(SinClaveMaestraError);
    expect(() => claveMaestra(undefined)).toThrow(SinClaveMaestraError);
    expect(() => claveMaestra(randomBytes(16).toString('hex'))).toThrow(SinClaveMaestraError);
    expect(hayClaveMaestra('')).toBe(false);
    expect(hayClaveMaestra(CLAVE.toString('hex'))).toBe(true);
  });
});

describe('cifrar y descifrar', () => {
  it('lo que entra es lo que sale', () => {
    expect(descifrar(cifrar(SECRETO, CLAVE), CLAVE)).toBe(SECRETO);
  });

  it('dos cifrados del mismo secreto son distintos', () => {
    // Si fueran iguales, quien vea la base sabría que dos entornos comparten
    // la misma clave sin tener que descifrar nada.
    expect(cifrar(SECRETO, CLAVE)).not.toBe(cifrar(SECRETO, CLAVE));
  });

  it('el blob no contiene el secreto', () => {
    expect(cifrar(SECRETO, CLAVE)).not.toContain('CREDENCIAL-DE-EJEMPLO');
  });

  it('con otra clave no se abre', () => {
    const blob = cifrar(SECRETO, CLAVE);
    expect(() => descifrar(blob, randomBytes(32))).toThrow(CifradoCorruptoError);
  });

  // GCM autentica además de cifrar: con un modo sin autenticación, un byte
  // cambiado daría otro texto y nadie se enteraría hasta que el procesador
  // rechazara la clave.
  it('UN BLOB MANIPULADO FALLA, NO DEVUELVE BASURA', () => {
    const blob = cifrar(SECRETO, CLAVE);
    const [v, iv, tag, cuerpo] = blob.split(':');
    const alterado = Buffer.from(cuerpo, 'base64');
    alterado[0] ^= 0xff;
    expect(() => descifrar([v, iv, tag, alterado.toString('base64')].join(':'), CLAVE))
      .toThrow(CifradoCorruptoError);
  });

  it('un formato desconocido se rechaza con su motivo', () => {
    expect(() => descifrar('v2:a:b:c', CLAVE)).toThrow(/formato desconocido/);
    expect(() => descifrar('cualquier cosa', CLAVE)).toThrow(CifradoCorruptoError);
  });
});

describe('la pista que ve el panel', () => {
  it('son los últimos cuatro: sirve para reconocerla, no para usarla', () => {
    expect(pista(SECRETO)).toBe('••••adie');
    expect(pista(SECRETO)).not.toContain('CREDENCIAL');
  });

  it('un secreto corto no se filtra entero', () => {
    expect(pista('abc')).toBe('••••');
  });
});
