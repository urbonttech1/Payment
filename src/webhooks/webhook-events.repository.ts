/**
 * Los avisos de los procesadores, guardados antes de hacerles caso.
 *
 * El orden es la regla entera: **primero se guarda el aviso, después se actúa
 * sobre él.** Un aviso que se procesa sin guardar es un aviso que se vuelve a
 * procesar en el siguiente reintento del procesador, y entonces el dinero se
 * mueve dos veces. La restricción `UNIQUE (provider, event_id)` de la base es
 * la que lo hace cumplir, no un `if`: Stripe reenvía el mismo evento durante
 * tres días si no recibe un 2xx, y manda varios a la vez.
 *
 * Y el estado del aviso es lo que permite reintentarlo nosotros: un evento que
 * se guardó pero cuyo proceso falló queda en `failed`, y se vuelve a intentar
 * sin depender de que el procesador insista.
 */

import type { ProviderEvent, ProviderEventType, ProviderName } from '../providers/provider.port';

export type EstadoDeAviso = 'received' | 'processed' | 'ignored' | 'failed';

export interface AvisoGuardado {
  id: string;
  provider: ProviderName;
  eventId: string;
  eventType: ProviderEventType;
  providerRef: string | null;
  status: EstadoDeAviso;
  attempts: number;
  lastError: string | null;
  payload: unknown;
  occurredAt: Date | null;
  createdAt: Date;
}

export interface WebhookEventsRepository {
  /**
   * Guarda el aviso si no lo teníamos.
   *
   * `yaExistia: true` es la señal de que **no hay que hacerle caso otra vez**.
   */
  guardarSiEsNuevo(evento: ProviderEvent): Promise<{ aviso: AvisoGuardado; yaExistia: boolean }>;

  porId(id: string): Promise<AvisoGuardado | null>;

  /** Los que se guardaron y no se llegaron a procesar, los más viejos primero. */
  pendientes(limite: number): Promise<AvisoGuardado[]>;

  /**
   * Los últimos avisos, para poder mirarlos desde el panel.
   *
   * Hasta ahora se guardaban y no había forma de verlos: un aviso que falló tres
   * veces era invisible salvo que alguien leyera los registros del servicio.
   */
  recientes(limite: number, estado?: EstadoDeAviso): Promise<AvisoGuardado[]>;

  /** Cuántos hay de cada estado. Es el resumen que el panel pone arriba. */
  resumenPorEstado(): Promise<Record<string, number>>;

  marcarProcesado(id: string): Promise<AvisoGuardado>;
  /** Para un tipo que conocemos pero que no mueve nada en URBONT. */
  marcarIgnorado(id: string, motivo: string): Promise<AvisoGuardado>;
  marcarFallido(id: string, error: string): Promise<AvisoGuardado>;
}

export const WEBHOOK_EVENTS_REPOSITORY = Symbol('WEBHOOK_EVENTS_REPOSITORY');
