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

  /**
   * La comisión de la plataforma, como fracción (0.15 = 15 %).
   *
   * Es el valor que se aplica cuando quien llama no pasa uno. Hoy la fuente de
   * verdad sigue siendo el panel de URBONT, que `urbont-api` lee y manda en cada
   * reparto; esto es el respaldo, y está puesto en el 15 % porque es lo que de
   * verdad se cobra hoy (`urbont-api/server/config/pricing.ts`), no el 10 % que
   * publica `/api/config`. Esa contradicción es una decisión de negocio
   * pendiente, y cuando se cierre, este es el sitio donde se fija una sola vez.
   */
  PLATFORM_COMMISSION_RATE: z.coerce.number().min(0).max(0.5).default(0.15),

  /**
   * La clave maestra con la que se cifran las credenciales de las pasarelas
   * (`payments.provider_credentials`). 32 bytes en hex o base64.
   *
   * Sin ella, las pasarelas salen sólo de las variables de entorno y el panel
   * no puede guardar ninguna: es lo que mantiene la caja fuera de la base.
   *
   *   openssl rand -hex 32
   */
  CREDENTIALS_KEY: z.string().optional(),

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
  /**
   * La *location* de Stripe Terminal para Tap to Pay.
   *
   * Sin ella el token del lector sale genérico: vale para el lector simulado y
   * no para cobrar de verdad en un iPhone.
   */
  STRIPE_TERMINAL_LOCATION_ID: z.string().optional(),
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
