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

  /**
   * Cómo se le paga a choferes y valets.
   *
   *  · `provider` — el procesador transfiere, como hace Stripe Connect.
   *  · `manual`   — el procesador deposita todo en la cuenta de URBONT, el
   *    libro apunta lo que se le debe a cada uno, y una persona transfiere
   *    desde el banco una o dos veces por semana y lo marca en el panel.
   *
   * Con Square no hay elección: no sabe pagarle a terceros. Pero esto es
   * configuración y no una consecuencia del procesador a propósito, porque el
   * modo lo decide el negocio: se puede querer liquidación manual con un
   * procesador que sí sabría transferir.
   *
   * Por defecto `provider`, que es lo que hay desplegado: poner esta variable
   * es lo que cambia el comportamiento, nunca desplegar.
   */
  SETTLEMENT_MODE: z.preprocess(
    (v) => (v === '' || v === undefined ? 'provider' : v),
    z.enum(['provider', 'manual']),
  ),

  /** Secreto compartido con urbont-api para firmar las llamadas entre servicios. */
  SERVICE_SHARED_SECRET: z.string().min(16, 'SERVICE_SHARED_SECRET debe tener al menos 16 caracteres'),

  /** A dónde avisa el servicio cuando un cobro cambia de estado. */
  URBONT_API_URL: z.string().url().optional(),

  /**
   * La dirección pública de este servicio, sin barra al final.
   *
   * Con ella se arma el enlace de webhooks de cada pasarela
   * (`https://payments.urbont.com/webhooks/stripe`). El panel lo enseña para
   * pegarlo en el procesador. Vacío —ECS inyecta `""` si no está puesta—
   * cuenta como la dirección de producción.
   */
  PAYMENTS_PUBLIC_URL: z.preprocess(
    (v) => (v === '' || v === undefined ? 'https://payments.urbont.com' : String(v).replace(/\/$/, '')),
    z.string().url(),
  ),

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

  /**
   * Square. Hacen falta **las dos**: sin localización, Square rechaza el cobro.
   *
   * El entorno es explícito porque el token de sandbox y el de producción no se
   * distinguen mirándolos, y un token de sandbox cobrando de verdad (o al
   * revés) es la clase de error que no se ve hasta que el dinero no llega.
   */
  SQUARE_ACCESS_TOKEN: z.string().optional(),
  SQUARE_LOCATION_ID: z.string().optional(),
  /**
   * `sandbox` o `production`. Vacío cuenta como `production`.
   *
   * Lo vacío se trata aparte a propósito: ECS inyecta `""` para una variable
   * que no está puesta, y un servicio de pagos que no arranca por una cadena
   * vacía es peor que uno que arranca apuntando a producción, que es donde de
   * verdad está la cuenta.
   */
  SQUARE_ENVIRONMENT: z.preprocess(
    (v) => (v === '' || v === undefined ? 'production' : v),
    z.enum(['sandbox', 'production']),
  ),
  SQUARE_WEBHOOK_SIGNATURE_KEY: z.string().optional(),
  /**
   * Tap to Pay con Square: la aplicación y la autorización OAuth de la cuenta.
   *
   * El SDK móvil de Square no usa el token del servidor: se autoriza con un token
   * OAuth que se pide con el *refresh token* de la autorización inicial
   * (`scripts/square-oauth.ts`). Hacen falta **los tres**; con menos, Square
   * cobra igual pero NO anuncia Tap to Pay. Tenerlos es el interruptor.
   */
  SQUARE_APPLICATION_ID: z.string().optional(),
  SQUARE_APPLICATION_SECRET: z.string().optional(),
  SQUARE_REFRESH_TOKEN: z.string().optional(),
  /**
   * La URL EXACTA que está puesta en el panel de Square.
   *
   * Square firma incluyendo la URL de entrega, así que un carácter de
   * diferencia hace que ninguna firma cuadre nunca. Es configuración por eso.
   */
  SQUARE_WEBHOOK_NOTIFICATION_URL: z.string().url().optional(),
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
