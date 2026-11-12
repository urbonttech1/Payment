/**
 * Cuál es la tarjeta principal de cada pasajero.
 *
 * Vive en URBONT y no en el procesador a propósito: Square no tiene ese
 * concepto y Stripe sí, pero guardarlo en uno de los dos haría que la
 * preferencia se perdiera al cambiar de pasarela. Es una decisión de URBONT
 * sobre su pasajero, no un dato del procesador.
 *
 * Se guarda junto al procesador que la emitió, porque **una tarjeta pertenece
 * al procesador que la guardó**: una preferencia de Stripe no significa nada
 * si quien cobra ahora es Square.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { POOL } from '../db/pool';
import type { ProviderName } from '../providers/provider.port';

export interface TarjetaPreferida {
  payerId: string;
  provider: ProviderName;
  cardRef: string;
}

@Injectable()
export class PreferredCardsRepository {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  /**
   * La preferida de este pagador **para este procesador**, o `null`.
   *
   * Filtrar por procesador no es cosmético: devolver la tarjeta de Stripe
   * cuando quien cobra es Square daría un cobro rechazado con un identificador
   * que ese procesador no conoce.
   */
  async obtener(payerId: string, provider: ProviderName): Promise<string | null> {
    const { rows } = await this.pool.query<{ card_ref: string }>(
      `SELECT card_ref FROM payments.preferred_cards
        WHERE payer_id = $1::uuid AND provider = $2`,
      [payerId, provider],
    );
    return rows[0]?.card_ref ?? null;
  }

  async fijar(payerId: string, provider: ProviderName, cardRef: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO payments.preferred_cards (payer_id, provider, card_ref, updated_at)
       VALUES ($1::uuid, $2, $3, NOW())
       ON CONFLICT (payer_id) DO UPDATE SET
         provider = EXCLUDED.provider,
         card_ref = EXCLUDED.card_ref,
         updated_at = NOW()`,
      [payerId, provider, cardRef],
    );
  }

  /** Se olvida la preferencia, por ejemplo al borrar la tarjeta. */
  async olvidar(payerId: string): Promise<void> {
    await this.pool.query('DELETE FROM payments.preferred_cards WHERE payer_id = $1::uuid', [payerId]);
  }
}
