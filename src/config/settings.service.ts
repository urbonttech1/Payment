/**
 * La configuración que se edita desde el panel, no desde el entorno.
 *
 * Hoy sólo guarda una cosa —qué procesador atiende los cobros nuevos— y es la
 * más consecuente que se puede cambiar desde un panel. El entorno se queda como
 * valor inicial y como respaldo: sin fila en la base manda `PAYMENT_PROVIDER`,
 * que es exactamente el comportamiento de antes de que esto existiera.
 *
 * Dos cosas que explican la forma:
 *
 *  · **Se refresca sola cada 30 segundos.** El servicio corre con dos tareas en
 *    ECS y el cambio entra por una de ellas; la otra tiene que enterarse. Un
 *    `setInterval` que sólo LEE no tiene el problema de los que hacen cosas
 *    —aquí no se duplica nada—, y treinta segundos es lo que tarda en propagarse
 *    un cambio del panel.
 *  · **Un fallo al leer no cambia nada.** Si la base no contesta, sigue valiendo
 *    lo último que se leyó. Una configuración que se cae sola al respaldo
 *    cambiaría el procesador de los cobros en el peor momento posible.
 */

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { POOL } from '../db/pool';
import { CONFIG, type Config } from './config';
import { ProviderRegistry } from '../providers/provider.registry';
import type { ProviderName } from '../providers/provider.port';

const CLAVE = 'routing';
const REFRESCO_MS = 30_000;

export interface ConfigDeRuteo {
  /** El procesador que atiende los cobros nuevos. */
  defaultProvider: ProviderName;
}

export interface RuteoGuardado extends ConfigDeRuteo {
  updatedBy: string | null;
  updatedAt: string | null;
  /** `entorno` mientras nadie lo haya cambiado desde el panel. */
  origen: 'panel' | 'entorno';
}

const PROCESADORES: ProviderName[] = ['stripe', 'square', 'adyen', 'finix', 'paypal', 'ach'];

export function esProcesador(v: unknown): v is ProviderName {
  return typeof v === 'string' && (PROCESADORES as string[]).includes(v);
}

@Injectable()
export class SettingsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SettingsService.name);
  private reloj: NodeJS.Timeout | null = null;
  private guardado: RuteoGuardado;
  /**
   * Cuántas lecturas seguidas han pedido una pasarela que esta tarea no tiene
   * montada, por pasarela. Un acierto, o que el panel pida otra, reinicia la cuenta.
   */
  private readonly fallosSeguidos = new Map<ProviderName, number>();

  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly config: Config,
    private readonly registry: ProviderRegistry,
  ) {
    this.guardado = {
      defaultProvider: config.PAYMENT_PROVIDER,
      updatedBy: null,
      updatedAt: null,
      origen: 'entorno',
    };
  }

  async onModuleInit(): Promise<void> {
    await this.refrescar();
    this.reloj = setInterval(() => {
      void this.refrescar();
    }, REFRESCO_MS);
    // Que un temporizador de configuración no sea motivo para que el proceso
    // no se pueda cerrar.
    this.reloj.unref?.();
  }

  onModuleDestroy(): void {
    if (this.reloj) clearInterval(this.reloj);
  }

  vigente(): RuteoGuardado {
    return { ...this.guardado, defaultProvider: this.registry.porDefecto };
  }

  /** Los que esta instalación puede usar: los que tienen credenciales montadas. */
  disponibles(): ProviderName[] {
    return this.registry.disponibles();
  }

  /**
   * Cambia el procesador de los cobros nuevos.
   *
   * No toca ningún cobro existente: cada uno vuelve al procesador que lo
   * originó. Lo que cambia es a partir de cuándo, y se aplica en esta tarea al
   * momento y en la otra cuando refresque.
   */
  async guardar(nuevo: ConfigDeRuteo, quien: string): Promise<RuteoGuardado> {
    // Que el registro lo valide ANTES de escribirlo: una fila que apunta a un
    // procesador sin credenciales convertiría todos los cobros nuevos en un
    // error, y el panel no tendría forma de volver atrás.
    this.registry.fijarPorDefecto(nuevo.defaultProvider);

    const valor = { defaultProvider: nuevo.defaultProvider };
    await this.pool.query(
      `INSERT INTO payments.settings (key, value, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [CLAVE, JSON.stringify(valor), quien.slice(0, 200)],
    );

    this.guardado = {
      defaultProvider: nuevo.defaultProvider,
      updatedBy: quien,
      updatedAt: new Date().toISOString(),
      origen: 'panel',
    };
    this.log.warn(`Procesador de los cobros nuevos: '${nuevo.defaultProvider}', cambiado por ${quien}.`);
    return this.vigente();
  }

  /** Vuelve a leer qué procesador atienden los cobros nuevos. */
  aplicar(): Promise<void> {
    return this.refrescar();
  }

  /**
   * El primer fallo es un aviso; a partir del segundo seguido, un error.
   *
   * Al arrancar, este servicio lee la configuración ANTES de que `CredentialsService`
   * monte las pasarelas guardadas en la base, así que si el panel eligió una de ellas
   * (hoy, Square) el primer intento falla en CADA arranque, y un instante después las
   * credenciales la montan y llaman a `aplicar()`. Eso es esperable, y escribirlo como
   * ERROR —dos por despliegue— hacía saltar en falso cualquier alarma sobre errores
   * y enseñaba un fallo que no lo era.
   *
   * Pero si en la lectura siguiente, 30 s después, sigue sin estar, sí pasa algo (una
   * credencial rota o que no se descifra) y no puede quedarse como un aviso que nadie
   * mira.
   */
  private avisarDeProcesadorSinMontar(nombre: ProviderName, causa: unknown): void {
    const intentos = (this.fallosSeguidos.get(nombre) ?? 0) + 1;
    this.fallosSeguidos.set(nombre, intentos);

    const base = `La configuración pide '${nombre}' y esta tarea no lo tiene montado: sigue '${this.registry.porDefecto}'. ${
      causa instanceof Error ? causa.message : String(causa)
    }`;
    if (intentos === 1) {
      this.log.warn(`${base} (esperable al arrancar: las credenciales se montan justo después)`);
    } else {
      this.log.error(`${base} (${intentos} intentos seguidos)`);
    }
  }

  private async refrescar(): Promise<void> {
    try {
      const { rows } = await this.pool.query<{ value: unknown; updated_by: string | null; updated_at: Date }>(
        `SELECT value, updated_by, updated_at FROM payments.settings WHERE key = $1`,
        [CLAVE],
      );
      const fila = rows[0];
      if (!fila) return; // nadie lo ha cambiado: manda el entorno

      const valor = typeof fila.value === 'string' ? JSON.parse(fila.value) : fila.value;
      const nombre = (valor as { defaultProvider?: unknown } | null)?.defaultProvider;
      if (!esProcesador(nombre)) {
        this.log.warn(`La configuración guardada dice '${String(nombre)}', que no es un procesador; manda el entorno.`);
        return;
      }

      this.guardado = {
        defaultProvider: nombre,
        updatedBy: fila.updated_by,
        updatedAt: fila.updated_at?.toISOString() ?? null,
        origen: 'panel',
      };

      if (this.registry.porDefecto !== nombre) {
        try {
          this.registry.fijarPorDefecto(nombre);
          this.fallosSeguidos.delete(nombre);
        } catch (e) {
          // El guardado apunta a un procesador que esta tarea todavía no montó.
          // La credencial llega sola en el siguiente refresco; mientras, se
          // sigue con el que hay, que al menos cobra.
          this.avisarDeProcesadorSinMontar(nombre, e);
        }
      } else {
        this.fallosSeguidos.delete(nombre);
      }
    } catch (e) {
      // Si no se puede leer, sigue valiendo lo último que se leyó.
      this.log.warn(`No se pudo leer la configuración: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
