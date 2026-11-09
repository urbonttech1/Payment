import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { POOL } from '../db/pool';
import type { ProviderEvent, ProviderEventType, ProviderName } from '../providers/provider.port';
import type {
  AvisoGuardado,
  EstadoDeAviso,
  WebhookEventsRepository,
} from './webhook-events.repository';

interface Fila {
  id: string;
  provider: string;
  event_id: string;
  event_type: string;
  provider_ref: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  payload: unknown;
  occurred_at: Date | null;
  created_at: Date;
}

const COLUMNAS = `
  id, provider, event_id, event_type, provider_ref, status,
  attempts, last_error, payload, occurred_at, created_at
`;

function aAviso(f: Fila): AvisoGuardado {
  return {
    id: f.id,
    provider: f.provider as ProviderName,
    eventId: f.event_id,
    eventType: f.event_type as ProviderEventType,
    providerRef: f.provider_ref,
    status: f.status as EstadoDeAviso,
    attempts: f.attempts,
    lastError: f.last_error,
    payload: f.payload,
    occurredAt: f.occurred_at,
    createdAt: f.created_at,
  };
}

@Injectable()
export class PgWebhookEventsRepository implements WebhookEventsRepository {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  async guardarSiEsNuevo(evento: ProviderEvent): Promise<{ aviso: AvisoGuardado; yaExistia: boolean }> {
    const insercion = await this.pool.query<Fila>(
      `INSERT INTO payments.webhook_events
         (provider, event_id, event_type, provider_ref, payload, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (provider, event_id) DO NOTHING
       RETURNING ${COLUMNAS}`,
      [
        evento.provider,
        evento.eventId,
        evento.type,
        evento.providerRef,
        // El aviso entero, tal como vino: es lo único que permite reconstruir
        // qué dijo el procesador cuando algo no cuadra meses después.
        JSON.stringify(evento.raw ?? {}),
        evento.occurredAt,
      ],
    );

    if (insercion.rows[0]) return { aviso: aAviso(insercion.rows[0]), yaExistia: false };

    const existente = await this.pool.query<Fila>(
      `SELECT ${COLUMNAS} FROM payments.webhook_events WHERE provider = $1 AND event_id = $2`,
      [evento.provider, evento.eventId],
    );
    if (!existente.rows[0]) {
      throw new Error(
        `El aviso ${evento.provider}:${evento.eventId} dio conflicto pero no se encuentra; ¿se borró a mano?`,
      );
    }
    return { aviso: aAviso(existente.rows[0]), yaExistia: true };
  }

  async porId(id: string): Promise<AvisoGuardado | null> {
    const { rows } = await this.pool.query<Fila>(
      `SELECT ${COLUMNAS} FROM payments.webhook_events WHERE id = $1`,
      [id],
    );
    return rows[0] ? aAviso(rows[0]) : null;
  }

  async pendientes(limite: number): Promise<AvisoGuardado[]> {
    const { rows } = await this.pool.query<Fila>(
      `SELECT ${COLUMNAS} FROM payments.webhook_events
        WHERE status IN ('received','failed')
        ORDER BY created_at ASC
        LIMIT $1`,
      [limite],
    );
    return rows.map(aAviso);
  }

  async marcarProcesado(id: string): Promise<AvisoGuardado> {
    return this.actualizar(
      `UPDATE payments.webhook_events
          SET status='processed', attempts=attempts+1, last_error=NULL, processed_at=NOW()
        WHERE id=$1 RETURNING ${COLUMNAS}`,
      [id],
    );
  }

  async marcarIgnorado(id: string, motivo: string): Promise<AvisoGuardado> {
    return this.actualizar(
      `UPDATE payments.webhook_events
          SET status='ignored', attempts=attempts+1, last_error=$2, processed_at=NOW()
        WHERE id=$1 RETURNING ${COLUMNAS}`,
      [id, motivo.slice(0, 500)],
    );
  }

  async marcarFallido(id: string, error: string): Promise<AvisoGuardado> {
    return this.actualizar(
      `UPDATE payments.webhook_events
          SET status='failed', attempts=attempts+1, last_error=$2
        WHERE id=$1 RETURNING ${COLUMNAS}`,
      [id, error.slice(0, 500)],
    );
  }

  private async actualizar(sql: string, params: unknown[]): Promise<AvisoGuardado> {
    const { rows } = await this.pool.query<Fila>(sql, params);
    if (!rows[0]) throw new Error(`No existe el aviso ${String(params[0])}`);
    return aAviso(rows[0]);
  }
}
