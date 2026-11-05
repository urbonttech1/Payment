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
