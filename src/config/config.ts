/**
 * Configuración del servicio, validada al arrancar.
 *
 * Si falta algo imprescindible, el proceso no arranca: un servicio de pagos a
 * medio configurar es peor que uno caído, porque acepta peticiones y falla a
 * mitad del cobro.
 */

import { z } from 'zod';

const esquema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.string().default('info'),

  /** Postgres. El servicio sólo toca su propio esquema `payments`. */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatoria'),

  /** El procesador que atiende los cobros nuevos. */
  PAYMENT_PROVIDER: z.enum(['stripe', 'square', 'adyen', 'finix', 'paypal', 'ach']).default('stripe'),

  /** Secreto compartido con urbont-api para firmar las llamadas entre servicios. */
  SERVICE_SHARED_SECRET: z.string().min(16, 'SERVICE_SHARED_SECRET debe tener al menos 16 caracteres'),

  /** A dónde avisa el servicio cuando un cobro cambia de estado. */
  URBONT_API_URL: z.string().url().optional(),

  // ── Credenciales de los procesadores ──────────────────────────────────────
  //
  // Opcionales a propósito: un adaptador sin credenciales no se monta, y el
  // servicio arranca igual. Así se puede levantar en local sin claves reales, y
  // el registro dice en el arranque qué procesadores quedaron disponibles.
  STRIPE_SECRET_KEY: z.string().startsWith('sk_', 'debe ser una clave secreta (sk_…), no una publicable').optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  /** Los eventos de Connect llegan por otro endpoint, con su propio secreto. */
  STRIPE_WEBHOOK_SECRET_CONNECT: z.string().optional(),
});

export type Config = z.infer<typeof esquema>;

export function cargarConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = esquema.safeParse(env);
  if (!r.success) {
    const detalle = r.error.issues.map((i) => `  · ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuración inválida:\n${detalle}`);
  }
  return r.data;
}

/**
 * Token de inyección de la configuración.
 *
 * Vive aquí y no en `app.module.ts` para que lo pueda pedir cualquier módulo
 * —el guardia de la firma, por ejemplo— sin importar el módulo raíz, que es el
 * que los importa a todos.
 */
export const CONFIG = Symbol('CONFIG');
