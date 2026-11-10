/**
 * El cifrado de las credenciales de los procesadores.
 *
 * Con la clave secreta de Stripe se mueve dinero de la cuenta de URBONT. Que
 * viva en una fila de Postgres significa que también vive en cada copia de
 * seguridad, en cada volcado que alguien se baja para depurar y en cada captura
 * de pantalla de un cliente de base de datos. Cifrarla no arregla todo eso,
 * pero convierte «quien vea la base se lleva la caja» en «quien vea la base se
 * lleva un bloque inútil sin la clave maestra, que vive en otro sitio».
 *
 * AES-256-GCM, que además de cifrar **autentica**: si alguien edita el blob a
 * mano en la base, descifrar falla en vez de devolver basura. Con un modo sin
 * autenticación —CBC, por ejemplo— un byte cambiado daría un texto distinto y
 * nadie se enteraría hasta que el procesador rechazara la clave.
 *
 * El formato lleva versión (`v1:`) a propósito: el día que haya que rotar el
 * algoritmo, se podrá distinguir lo viejo de lo nuevo sin adivinar.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALGORITMO = 'aes-256-gcm';
const IV_BYTES = 12; // lo que recomienda GCM
const CLAVE_BYTES = 32;

export class SinClaveMaestraError extends Error {
  constructor() {
    super(
      'CREDENTIALS_KEY no está configurada o no mide 32 bytes: ' +
      'sin ella no se pueden guardar ni leer credenciales desde el panel.',
    );
    this.name = 'SinClaveMaestraError';
  }
}

export class CifradoCorruptoError extends Error {
  constructor(detalle: string) {
    super(`No se pudo descifrar la credencial: ${detalle}`);
    this.name = 'CifradoCorruptoError';
  }
}

/**
 * La clave maestra, desde el entorno.
 *
 * Acepta hex (64 caracteres) o base64, que es como la va a pegar quien la
 * genere con `openssl rand`. Cualquier otra cosa se rechaza al arrancar y no
 * cuando alguien intente guardar una credencial.
 */
export function claveMaestra(crudo: string | undefined): Buffer {
  const texto = (crudo ?? '').trim();
  if (!texto) throw new SinClaveMaestraError();

  const candidatas = [
    /^[0-9a-fA-F]{64}$/.test(texto) ? Buffer.from(texto, 'hex') : null,
    Buffer.from(texto, 'base64'),
  ];
  const clave = candidatas.find((c) => c?.length === CLAVE_BYTES);
  if (!clave) throw new SinClaveMaestraError();
  return clave;
}

/** `true` si hay una clave maestra utilizable. */
export function hayClaveMaestra(crudo: string | undefined): boolean {
  try {
    claveMaestra(crudo);
    return true;
  } catch {
    return false;
  }
}

export function cifrar(texto: string, clave: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITMO, clave, iv);
  const cuerpo = Buffer.concat([cipher.update(texto, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), cuerpo.toString('base64')].join(':');
}

export function descifrar(blob: string, clave: Buffer): string {
  const partes = blob.split(':');
  if (partes.length !== 4 || partes[0] !== VERSION) {
    throw new CifradoCorruptoError(`formato desconocido (${partes[0] ?? 'vacío'})`);
  }
  const [, iv, tag, cuerpo] = partes;
  try {
    const decipher = createDecipheriv(ALGORITMO, clave, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(cuerpo, 'base64')), decipher.final()]).toString('utf8');
  } catch (e) {
    // Clave equivocada o blob manipulado: GCM no distingue, y mejor así.
    throw new CifradoCorruptoError(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Lo que el panel puede ver de una credencial: sus últimos caracteres.
 *
 * Suficiente para reconocer cuál está puesta —y para notar que alguien subió la
 * de pruebas a producción— e inútil para usarla.
 */
export function pista(secreto: string): string {
  const limpio = secreto.trim();
  if (limpio.length <= 4) return '••••';
  return `••••${limpio.slice(-4)}`;
}
