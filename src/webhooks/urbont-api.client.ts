/**
 * El aviso de vuelta hacia `urbont-api`.
 *
 * Es la otra dirección del túnel: hasta ahora `urbont-api` llamaba al micro, y
 * aquí el micro le cuenta lo que le dijo el procesador. La diferencia con antes
 * es que lo que viaja es un evento de **URBONT** —`payment.captured`,
 * `refund.succeeded`— y no uno de Stripe. Añadir Square no cambia ni una línea
 * al otro lado.
 *
 * Va firmado con el mismo canon que las llamadas de ida
 * (`src/internal/firma.ts`), así que el secreto compartido es el mismo y
 * `urbont-api` lo verifica con su propia copia de esa función.
 *
 * Si no contesta, se lanza: quien llama marca el aviso como fallido y lo
 * reintenta después. Un evento que se dio por entregado sin entregarse es un
 * viaje que nunca se enteró de que le cobraron.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG, type Config } from '../config/config';
import { cabecerasDeFirma } from '../internal/firma';
import type { Cents, Currency, ProviderEventType, ProviderName } from '../providers/provider.port';

/** Lo que `urbont-api` recibe. Nada de aquí es vocabulario de un procesador. */
export interface EventoParaUrbont {
  eventId: string;
  type: ProviderEventType;
  provider: ProviderName;
  /** La clave del cobro: con ella `urbont-api` sabe de qué viaje habla. */
  chargeKey: string | null;
  rideId: string | null;
  kind: string | null;
  providerRef: string | null;
  amountCents?: Cents;
  currency?: Currency;
  occurredAt: string;
}

export class UrbontApiNoContestaError extends Error {
  constructor(detalle: string) {
    super(`urbont-api no recibió el evento: ${detalle}`);
    this.name = 'UrbontApiNoContestaError';
  }
}

const RUTA = '/api/internal/payments/events';
const TIMEOUT_MS = 8_000;

@Injectable()
export class UrbontApiClient {
  private readonly log = new Logger(UrbontApiClient.name);

  constructor(@Inject(CONFIG) private readonly config: Config) {}

  /** `false` si no hay a dónde avisar: en local no siempre hay un backend. */
  get configurado(): boolean {
    return Boolean(this.config.URBONT_API_URL);
  }

  async avisar(evento: EventoParaUrbont): Promise<void> {
    if (!this.configurado) {
      this.log.debug(`URBONT_API_URL sin configurar: no se avisa de ${evento.type}.`);
      return;
    }

    const base = (this.config.URBONT_API_URL ?? '').replace(/\/+$/, '');
    const cuerpo = JSON.stringify(evento);

    let respuesta: Response;
    try {
      respuesta = await fetch(`${base}${RUTA}`, {
        method: 'POST',
        headers: {
          ...cabecerasDeFirma({ metodo: 'POST', ruta: RUTA, cuerpo }, this.config.SERVICE_SHARED_SECRET),
          'content-type': 'application/json',
          // El id del evento, también en cabecera: así el otro lado puede
          // descartar un repetido sin abrir el cuerpo.
          'idempotency-key': evento.eventId,
        },
        body: cuerpo,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new UrbontApiNoContestaError(e instanceof Error ? e.message : String(e));
    }

    if (!respuesta.ok) {
      const detalle = await respuesta.text().catch(() => '');
      throw new UrbontApiNoContestaError(`HTTP ${respuesta.status} ${detalle.slice(0, 200)}`);
    }
  }
}
