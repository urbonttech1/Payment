/**
 * Las credenciales de cada pasarela, escritas desde el panel.
 *
 * Hasta ahora venían de variables de entorno, así que añadir una pasarela era
 * tocar infraestructura y redesplegar. Aquí se pegan en el panel y el servicio
 * monta el adaptador al momento.
 *
 * Cuatro reglas, y cada una responde a una forma concreta de hacerse daño:
 *
 *  1. **Se prueban antes de guardarse.** Se monta el adaptador con la
 *     credencial nueva y se le pide un `ping`. Guardar una clave rota dejaría
 *     el servicio sin cobrar y a quien la pegó sin enterarse hasta el primer
 *     viaje.
 *  2. **Nunca se devuelven.** El panel ve los últimos cuatro caracteres, quién
 *     la puso y cuándo. Una API que devuelve la clave secreta convierte
 *     cualquier fallo de permisos del panel en una fuga de la caja.
 *  3. **Se guardan cifradas**, con la clave maestra fuera de la base.
 *  4. **El entorno gana al arrancar.** Si una pasarela ya viene por variables
 *     de entorno, esas mandan: es lo que hay desplegado y no se le cambia el
 *     procesador a nadie por una fila que alguien dejó a medias.
 */

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { POOL } from '../db/pool';
import { CONFIG, type Config } from './config';
import { ProviderRegistry } from '../providers/provider.registry';
import { SettingsService } from './settings.service';
import { crearStripeProvider } from '../providers/stripe/stripe.module';
import { crearSquareProvider } from '../providers/square/square.module';
import type { PaymentProvider, ProviderName } from '../providers/provider.port';
import { cifrar, claveMaestra, descifrar, hayClaveMaestra, pista } from './cifrado';
import { enlacesDeWebhook, urlDeWebhook, type EnlaceWebhook } from './enlacesWebhook';

/** Qué campos pide cada pasarela. El panel dibuja el formulario con esto. */
export interface CampoDeCredencial {
  nombre: string;
  etiqueta: string;
  requerido: boolean;
  /** `true` si no debe volver a mostrarse nunca. */
  secreto: boolean;
  ayuda?: string;
}

export const CAMPOS: Record<string, CampoDeCredencial[]> = {
  stripe: [
    { nombre: 'secretKey', etiqueta: 'Clave secreta', requerido: true, secreto: true, ayuda: 'Empieza por sk_live_ o sk_test_' },
    { nombre: 'webhookSecret', etiqueta: 'Secreto del webhook', requerido: false, secreto: true, ayuda: 'whsec_… del endpoint de la cuenta. La URL que hay que pegar en Stripe está arriba.' },
    { nombre: 'webhookSecretConnect', etiqueta: 'Secreto del webhook de Connect', requerido: false, secreto: true, ayuda: 'El del endpoint de las cuentas de los choferes. Usa la misma URL, el otro secreto.' },
    { nombre: 'terminalLocationId', etiqueta: 'Location de Tap to Pay', requerido: false, secreto: false, ayuda: 'tml_… sin esto el lector solo funciona simulado' },
  ],
  // Square pide DOS cosas, no una: sin localización rechaza cada cobro. Por eso
  // las dos son obligatorias y el `ping` no pasaría sin ellas.
  square: [
    { nombre: 'accessToken', etiqueta: 'Token de acceso', requerido: true, secreto: true, ayuda: 'EAAA… del panel de Square; el de sandbox solo cobra en pruebas' },
    { nombre: 'locationId', etiqueta: 'Localización que cobra', requerido: true, secreto: false, ayuda: 'L… la location del vendedor' },
    { nombre: 'environment', etiqueta: 'Entorno', requerido: false, secreto: false, ayuda: 'sandbox o production; vacío = production' },
    { nombre: 'webhookSignatureKey', etiqueta: 'Clave de firma del webhook', requerido: false, secreto: true, ayuda: 'La del endpoint, en el panel de Square. La URL que hay que pegar está arriba: no se escribe, Square firma esa exactamente.' },
  ],
};

export interface CredencialParaElPanel {
  provider: ProviderName;
  /** Lo único que se ve de la clave. */
  pista: string | null;
  estado: 'pending' | 'ok' | 'invalid';
  ultimoError: string | null;
  comprobadaEn: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  /** `true` si el procesador está montado y puede cobrar ahora mismo. */
  montado: boolean;
  /** `entorno` si manda una variable de entorno; `panel` si manda esta tabla. */
  origen: 'entorno' | 'panel' | 'ninguno';
  campos: CampoDeCredencial[];
  /** Los enlaces que hay que pegar en el panel de esa pasarela. */
  webhooks: EnlaceWebhook[];
}

export class CredencialInvalidaError extends Error {
  constructor(public readonly provider: string, detalle: string) {
    super(`Las credenciales de ${provider} no sirven: ${detalle}`);
    this.name = 'CredencialInvalidaError';
  }
}

export class SinSoporteError extends Error {
  constructor(provider: string) {
    super(`Todavía no hay adaptador para '${provider}': sus credenciales no se pueden montar.`);
    this.name = 'SinSoporteError';
  }
}

/** Lo mismo que el ruteo: dos tareas, y el cambio entra por una de ellas. */
const REFRESCO_MS = 30_000;

@Injectable()
export class CredentialsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(CredentialsService.name);
  /** Las que vinieron del entorno al arrancar; no se pisan desde el panel. */
  private readonly delEntorno = new Set<ProviderName>();
  /** `updated_at` de lo último que esta tarea montó, para no rehacerlo cada vuelta. */
  private readonly montadoEn = new Map<string, string>();
  private reloj: NodeJS.Timeout | null = null;

  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly config: Config,
    private readonly registry: ProviderRegistry,
    private readonly settings: SettingsService,
  ) {}

  async onModuleInit(): Promise<void> {
    for (const p of this.registry.disponibles()) this.delEntorno.add(p);
    if (!this.cifradoDisponible) {
      this.log.log('Sin CREDENTIALS_KEY: las pasarelas salen sólo de las variables de entorno.');
    }
    await this.sincronizar();
    this.reloj = setInterval(() => {
      void this.sincronizar();
    }, REFRESCO_MS);
    this.reloj.unref?.();
  }

  onModuleDestroy(): void {
    if (this.reloj) clearInterval(this.reloj);
  }

  get cifradoDisponible(): boolean {
    return hayClaveMaestra(this.config.CREDENTIALS_KEY);
  }

  /** Lo que el panel dibuja. Sin un solo secreto dentro. */
  async listar(): Promise<CredencialParaElPanel[]> {
    const guardadas = await this.leerFilas();
    const porProveedor = new Map(guardadas.map((f) => [f.provider, f]));
    const montados = new Set(this.registry.disponibles());

    return Object.keys(CAMPOS).map((nombre) => {
      const provider = nombre as ProviderName;
      const fila = porProveedor.get(provider);
      const origen: CredencialParaElPanel['origen'] = this.delEntorno.has(provider)
        ? 'entorno'
        : fila ? 'panel' : 'ninguno';

      return {
        provider,
        pista: fila?.pista ?? null,
        estado: (fila?.estado as 'pending' | 'ok' | 'invalid') ?? 'pending',
        ultimoError: fila?.ultimo_error ?? null,
        comprobadaEn: fila?.comprobada_en?.toISOString() ?? null,
        updatedBy: fila?.updated_by ?? null,
        updatedAt: fila?.updated_at?.toISOString() ?? null,
        montado: montados.has(provider),
        origen,
        campos: CAMPOS[nombre],
        webhooks: enlacesDeWebhook(this.config.PAYMENTS_PUBLIC_URL, nombre, this.urlVerificada(provider)),
      };
    });
  }

  /**
   * Guarda unas credenciales nuevas, **después** de comprobar que valen.
   *
   * Si el `ping` falla no se guarda nada: el servicio se queda con lo que
   * tenía, que al menos cobra.
   */
  async guardar(
    provider: ProviderName,
    valores: Record<string, string>,
    quien: string,
  ): Promise<CredencialParaElPanel[]> {
    if (!this.cifradoDisponible) throw new Error('CREDENTIALS_KEY no está configurada en este servicio.');
    if (!CAMPOS[provider]) throw new SinSoporteError(provider);

    for (const campo of CAMPOS[provider]) {
      if (campo.requerido && !valores[campo.nombre]?.trim()) {
        throw new CredencialInvalidaError(provider, `falta ${campo.etiqueta}`);
      }
    }

    const adaptador = this.construir(provider, this.conUrlDeWebhook(provider, valores));
    if (!adaptador) throw new SinSoporteError(provider);

    try {
      await adaptador.ping();
    } catch (e) {
      throw new CredencialInvalidaError(provider, e instanceof Error ? e.message : String(e));
    }

    const clave = claveMaestra(this.config.CREDENTIALS_KEY);
    const principal = CAMPOS[provider].find((c) => c.requerido)?.nombre ?? '';

    await this.pool.query(
      `INSERT INTO payments.provider_credentials
         (provider, secreto_cifrado, pista, estado, ultimo_error, comprobada_en, updated_by, updated_at)
       VALUES ($1,$2,$3,'ok',NULL,NOW(),$4,NOW())
       ON CONFLICT (provider) DO UPDATE SET
         secreto_cifrado = EXCLUDED.secreto_cifrado,
         pista = EXCLUDED.pista,
         estado = 'ok', ultimo_error = NULL,
         comprobada_en = NOW(), updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [provider, cifrar(JSON.stringify(this.conUrlDeWebhook(provider, valores)), clave), pista(valores[principal] ?? ''), quien.slice(0, 200)],
    );

    // Montarlo sólo si el entorno no manda: lo desplegado gana.
    if (!this.delEntorno.has(provider)) {
      this.registry.montar(adaptador);
      this.log.warn(`Pasarela '${provider}' montada con credenciales del panel, puestas por ${quien}.`);
    } else {
      this.log.warn(
        `Credenciales de '${provider}' guardadas por ${quien}, pero sigue mandando la variable de entorno.`,
      );
    }

    return this.listar();
  }

  /** Quita unas credenciales guardadas. No desmonta lo que venga del entorno. */
  async borrar(provider: ProviderName, quien: string): Promise<CredencialParaElPanel[]> {
    await this.pool.query('DELETE FROM payments.provider_credentials WHERE provider = $1', [provider]);
    this.log.warn(`Credenciales de '${provider}' borradas por ${quien}. Seguirá montado hasta el próximo arranque.`);
    return this.listar();
  }

  // ── Interno ───────────────────────────────────────────────────────────────

  private async leerFilas() {
    try {
      const { rows } = await this.pool.query<{
        provider: ProviderName; secreto_cifrado: string; pista: string | null;
        estado: string; ultimo_error: string | null; comprobada_en: Date | null;
        updated_by: string | null; updated_at: Date | null;
      }>(
        `SELECT provider, secreto_cifrado, pista, estado, ultimo_error, comprobada_en, updated_by, updated_at
           FROM payments.provider_credentials`,
      );
      return rows;
    } catch (e) {
      this.log.warn(`No se pudieron leer las credenciales: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  /**
   * Monta lo que el panel guardó y esta tarea todavía no tiene.
   *
   * Cada tarea lo hace sola, leyendo la base: guardar una clave en una no
   * obliga a reiniciar el servicio para que la otra cobre con ella. Si no
   * cambió `updated_at`, no se vuelve a montar.
   */
  private async sincronizar(): Promise<void> {
    if (!this.cifradoDisponible) return;
    const clave = claveMaestra(this.config.CREDENTIALS_KEY);
    let montoAlgo = false;

    for (const fila of await this.leerFilas()) {
      if (this.delEntorno.has(fila.provider)) continue;
      const marca = fila.updated_at ? new Date(fila.updated_at).toISOString() : '';
      if (this.montadoEn.get(fila.provider) === marca) continue;
      try {
        const valores = JSON.parse(descifrar(fila.secreto_cifrado, clave)) as Record<string, string>;
        const adaptador = this.construir(fila.provider, valores);
        if (!adaptador) continue;
        this.registry.montar(adaptador);
        this.montadoEn.set(fila.provider, marca);
        montoAlgo = true;
        this.log.log(`Pasarela '${fila.provider}' montada con las credenciales del panel.`);
      } catch (e) {
        // Una credencial que no se puede descifrar o montar no tumba el
        // arranque: se grita y se reintenta en la siguiente vuelta.
        this.log.error(
          `No se pudo montar '${fila.provider}': ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    if (montoAlgo) await this.settings.aplicar();
  }

  /**
   * La URL con la que ese procesador firma. Square puede traer una fija en el
   * entorno; el resto sale de la dirección pública del servicio.
   */
  private urlVerificada(provider: string): string {
    if (provider === 'square' && this.config.SQUARE_WEBHOOK_NOTIFICATION_URL) {
      return this.config.SQUARE_WEBHOOK_NOTIFICATION_URL;
    }
    return urlDeWebhook(this.config.PAYMENTS_PUBLIC_URL, provider);
  }

  /** Deja en el JSON guardado la URL que de verdad se comprueba. */
  private conUrlDeWebhook(provider: ProviderName, valores: Record<string, string>): Record<string, string> {
    if (provider !== 'square') return valores;
    return { ...valores, webhookNotificationUrl: this.urlVerificada('square') };
  }

  /** El adaptador de ese procesador con esos valores, o `null` si no hay. */
  private construir(provider: ProviderName, valores: Record<string, string>): PaymentProvider | null {
    if (provider === 'stripe') {
      return crearStripeProvider({
        ...this.config,
        STRIPE_SECRET_KEY: valores.secretKey,
        STRIPE_WEBHOOK_SECRET: valores.webhookSecret || undefined,
        STRIPE_WEBHOOK_SECRET_CONNECT: valores.webhookSecretConnect || undefined,
        STRIPE_TERMINAL_LOCATION_ID: valores.terminalLocationId || undefined,
      });
    }
    if (provider === 'square') {
      return crearSquareProvider({
        SQUARE_ACCESS_TOKEN: valores.accessToken,
        SQUARE_LOCATION_ID: valores.locationId,
        SQUARE_ENVIRONMENT: valores.environment === 'sandbox' ? 'sandbox' : 'production',
        SQUARE_WEBHOOK_SIGNATURE_KEY: valores.webhookSignatureKey || undefined,
        // La que se enseña en el panel. Square firma incluyéndola, así que no
        // se deja que quien pega la credencial escriba otra.
        SQUARE_WEBHOOK_NOTIFICATION_URL: this.urlVerificada('square'),
      });
    }
    // Adyen, Finix, PayPal…: cuando exista su adaptador, se añade aquí y en
    // CAMPOS, y el panel dibuja su formulario solo.
    return null;
  }
}
