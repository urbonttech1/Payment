/**
 * Los avisos de los procesadores: recibirlos, creerlos sólo si vienen firmados,
 * y hacerles caso una sola vez.
 *
 * El orden de los pasos ES la corrección de todo esto:
 *
 *  1. **Se verifica la firma.** Un aviso sin firma comprobada es un aviso de
 *     cualquiera, y estos avisos mueven dinero en nuestro libro.
 *  2. **Se guarda**, con `UNIQUE (provider, event_id)`. Si ya estaba, se
 *     responde que sí y no se hace nada más: Stripe reenvía el mismo evento
 *     durante tres días hasta recibir un 2xx, y manda varios a la vez.
 *  3. **Se actúa.** Y sólo entonces se marca como procesado.
 *
 * Si el paso 3 falla, el aviso queda en `failed` y se reintenta desde aquí
 * (`reintentarPendientes`), sin depender de que el procesador insista. Y
 * reintentar es seguro porque cada efecto es idempotente: marcar capturado dos
 * veces no cobra dos veces, y los asientos del libro llevan clave propia.
 *
 * Un detalle de la convivencia que importa más de lo que parece: a este
 * endpoint llegan **todos** los eventos de la cuenta, incluidos los de los
 * cobros que creó `urbont-api` por su cuenta. Esos no están en nuestro libro, y
 * no son un error: se marcan como ignorados y los sigue atendiendo el webhook
 * viejo. Tratarlos como un fallo llenaría la cola de reintentos de trabajo
 * imposible.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProviderRegistry } from '../providers/provider.registry';
import {
  TRANSACTIONS_REPOSITORY,
  type Transaction,
  type TransactionsRepository,
} from '../ledger/transactions.repository';
import { ENTRIES_REPOSITORY, type EntriesRepository } from '../ledger/entries.repository';
import { asientosDeReembolso } from '../ledger/asientos';
import { PAYEES_REPOSITORY, type PayeesRepository } from '../payees/payees.repository';
import type { ProviderEvent, ProviderName, WebhookRequest } from '../providers/provider.port';
import {
  WEBHOOK_EVENTS_REPOSITORY,
  type AvisoGuardado,
  type WebhookEventsRepository,
} from './webhook-events.repository';
import { UrbontApiClient, type EventoParaUrbont } from './urbont-api.client';

export interface ResultadoDeAviso {
  recibidos: number;
  nuevos: number;
  repetidos: number;
  procesados: number;
  ignorados: number;
  fallidos: number;
}

const VACIO: ResultadoDeAviso = {
  recibidos: 0, nuevos: 0, repetidos: 0, procesados: 0, ignorados: 0, fallidos: 0,
};

/** Lo que `urbont-api` necesita saber. Del resto se entera por el panel. */
const SE_AVISA = new Set<ProviderEvent['type']>([
  'payment.captured',
  'payment.failed',
  'refund.succeeded',
  'chargeback.opened',
]);

@Injectable()
export class WebhooksService {
  private readonly log = new Logger(WebhooksService.name);

  constructor(
    private readonly registry: ProviderRegistry,
    @Inject(WEBHOOK_EVENTS_REPOSITORY) private readonly avisos: WebhookEventsRepository,
    @Inject(TRANSACTIONS_REPOSITORY) private readonly transacciones: TransactionsRepository,
    @Inject(PAYEES_REPOSITORY) private readonly beneficiarios: PayeesRepository,
    @Inject(ENTRIES_REPOSITORY) private readonly asientos: EntriesRepository,
    private readonly urbont: UrbontApiClient,
  ) {}

  /**
   * Un aviso que acaba de llegar.
   *
   * Lanza si la firma no cuadra —eso es un 400 y no se reintenta— y si no se
   * puede guardar —eso es un 500, y conviene que el procesador reintente—. Un
   * fallo al procesar NO lanza: el aviso ya está guardado y es nuestro, así que
   * se responde 2xx y se reintenta por nuestra cuenta.
   */
  async recibir(provider: ProviderName, req: WebhookRequest): Promise<ResultadoDeAviso> {
    const adaptador = this.registry.paraCobroExistente(provider);
    const eventos = await adaptador.parseWebhook(req);

    const total: ResultadoDeAviso = { ...VACIO, recibidos: eventos.length };

    for (const evento of eventos) {
      const { aviso, yaExistia } = await this.avisos.guardarSiEsNuevo(evento);
      if (yaExistia) {
        total.repetidos++;
        this.log.log(`Aviso repetido ${provider}:${evento.eventId} (${aviso.status}): no se vuelve a procesar.`);
        continue;
      }
      total.nuevos++;
      const r = await this.procesarConCuidado(aviso, evento);
      total[r]++;
    }

    return total;
  }

  /**
   * Los avisos guardados que no se llegaron a procesar.
   *
   * Lo llama el cron de `urbont-api` por el endpoint interno. Un evento cuyo
   * proceso falló no se queda esperando a que Stripe insista: Stripe se rinde a
   * los tres días.
   */
  async reintentarPendientes(limite = 50): Promise<ResultadoDeAviso> {
    const pendientes = await this.avisos.pendientes(limite);
    const total: ResultadoDeAviso = { ...VACIO, recibidos: pendientes.length, nuevos: pendientes.length };

    for (const aviso of pendientes) {
      const evento: ProviderEvent = {
        eventId: aviso.eventId,
        provider: aviso.provider,
        type: aviso.eventType,
        providerRef: aviso.providerRef,
        occurredAt: aviso.occurredAt ?? aviso.createdAt,
        raw: aviso.payload,
      };
      const r = await this.procesarConCuidado(aviso, evento);
      total[r]++;
    }

    if (pendientes.length > 0) {
      this.log.log(`Reintento de avisos: ${JSON.stringify(total)}`);
    }
    return total;
  }

  private async procesarConCuidado(
    aviso: AvisoGuardado,
    evento: ProviderEvent,
  ): Promise<'procesados' | 'ignorados' | 'fallidos'> {
    try {
      const resultado = await this.procesar(evento);
      if (resultado.ignorado) {
        await this.avisos.marcarIgnorado(aviso.id, resultado.motivo);
        this.log.log(`${evento.type} ${evento.eventId}: ignorado (${resultado.motivo})`);
        return 'ignorados';
      }
      await this.avisos.marcarProcesado(aviso.id);
      return 'procesados';
    } catch (e) {
      const detalle = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      await this.avisos.marcarFallido(aviso.id, detalle).catch(() => {});
      this.log.error(`${evento.type} ${evento.eventId}: falló el proceso (${detalle}); queda para reintentar.`);
      return 'fallidos';
    }
  }

  // ── Qué hace cada aviso ───────────────────────────────────────────────────

  private async procesar(evento: ProviderEvent): Promise<{ ignorado: boolean; motivo: string }> {
    const sigue = { ignorado: false, motivo: '' };

    // El alta de un beneficiario no habla de ningún cobro: va por su lado.
    if (evento.type === 'payee.updated') {
      return this.actualizarBeneficiario(evento);
    }
    if (evento.type === 'payout.paid' || evento.type === 'payout.failed') {
      // Es el barrido del saldo del procesador hacia el banco. No toca el
      // reparto de ningún viaje; se guarda y se deja constancia.
      return { ignorado: true, motivo: 'pago del procesador a su banco; no afecta a ningún viaje' };
    }

    if (!evento.providerRef) {
      return { ignorado: true, motivo: 'el aviso no trae referencia de cobro' };
    }

    const tx = await this.transacciones.porReferenciaDelProveedor(evento.provider, evento.providerRef);
    if (!tx) {
      // El caso de la convivencia: ese cobro lo creó `urbont-api` por su
      // cuenta. No es nuestro y lo atiende el webhook viejo.
      return { ignorado: true, motivo: `el cobro ${evento.providerRef} no está en nuestro libro` };
    }

    switch (evento.type) {
      case 'payment.authorized':
        if (tx.status === 'pending') {
          await this.transacciones.marcarAutorizada(tx.id, evento.providerRef);
        }
        break;

      case 'payment.captured':
        // Puede llegar antes que nuestra propia respuesta de captura, o después:
        // en los dos casos el resultado es el mismo, y esto es lo que hace que
        // un cobro no se quede en 'authorized' porque se reinició el proceso.
        if (tx.status !== 'captured') {
          await this.transacciones.marcarCapturada(
            tx.id,
            evento.providerRef,
            evento.amount ?? tx.amountCents,
          );
        }
        break;

      case 'payment.failed':
        if (tx.status !== 'captured' && tx.status !== 'refunded') {
          await this.transacciones.marcarFallida(tx.id, 'provider_event_payment_failed');
        }
        break;

      case 'refund.succeeded':
        await this.anotarReembolso(tx, evento);
        break;

      case 'chargeback.opened':
      case 'chargeback.closed':
        // Una disputa no mueve dinero todavía: lo mueve perderla, y eso llega
        // como reembolso. Aquí sólo hay que avisar para que alguien la pelee.
        this.log.warn(`Disputa ${evento.type} sobre ${evento.providerRef} (viaje ${tx.rideId ?? 'sin viaje'}).`);
        break;

      default:
        return { ignorado: true, motivo: `tipo sin tratamiento: ${evento.type}` };
    }

    if (SE_AVISA.has(evento.type)) await this.avisarAUrbont(tx, evento);
    return sigue;
  }

  /**
   * Un reembolso en el libro.
   *
   * Los asientos salen del saldo de la plataforma y reducen su ingreso, y eso
   * es la verdad y no una simplificación: el procesador saca el dinero del
   * saldo de URBONT. Si al chofer ya se le había pagado su parte, la devolución
   * la absorbe la plataforma —recuperarla de él es una decisión de negocio, no
   * un asiento—.
   */
  private async anotarReembolso(tx: Transaction, evento: ProviderEvent): Promise<void> {
    const devuelto = evento.amount ?? tx.amountCents;
    if (devuelto <= 0) return;

    // La identidad del asiento es la referencia del reembolso, no la del
    // evento: Stripe manda `charge.refunded` Y `refund.created` del mismo
    // reembolso, y además nosotros mismos pudimos haberlo pedido por API. Los
    // tres caminos tienen que producir el mismo asiento una sola vez.
    await this.asientos.asentar(
      asientosDeReembolso({
        transactionId: tx.id,
        refundRef: evento.objectRef ?? evento.eventId,
        devueltoCents: devuelto,
        currency: tx.currency,
        provider: tx.provider,
      }),
    );

    // Sólo se marca reembolsado cuando se devolvió todo: un reembolso parcial
    // deja el cobro capturado, porque capturado sigue estando.
    if (devuelto >= tx.amountCents && tx.status !== 'refunded') {
      await this.transacciones.marcarReembolsada(tx.id);
    }
  }

  private async actualizarBeneficiario(evento: ProviderEvent): Promise<{ ignorado: boolean; motivo: string }> {
    if (!evento.providerRef) {
      return { ignorado: true, motivo: 'el aviso de beneficiario no trae cuenta' };
    }
    const adaptador = this.registry.paraCobroExistente(evento.provider);
    const estado = await adaptador.payeeStatus(evento.providerRef);

    // Buscamos por la cuenta, no por la persona: el aviso del procesador habla
    // de su cuenta y no sabe nada de nuestros identificadores.
    const payee = await this.beneficiarios.porReferencia(evento.provider, evento.providerRef);
    if (!payee) {
      return { ignorado: true, motivo: `la cuenta ${evento.providerRef} no es de ningún beneficiario nuestro` };
    }

    await this.beneficiarios.actualizarEstado(payee.payeeId, evento.provider, estado);
    this.log.log(`Beneficiario ${payee.payeeId}: su cuenta en ${evento.provider} pasa a '${estado}'.`);
    return { ignorado: false, motivo: '' };
  }

  private async avisarAUrbont(tx: Transaction, evento: ProviderEvent): Promise<void> {
    const aviso: EventoParaUrbont = {
      eventId: evento.eventId,
      type: evento.type,
      provider: evento.provider,
      chargeKey: tx.idempotencyKey,
      rideId: tx.rideId,
      kind: tx.kind,
      providerRef: evento.providerRef,
      ...(evento.amount !== undefined ? { amountCents: evento.amount } : {}),
      currency: tx.currency,
      occurredAt: evento.occurredAt.toISOString(),
    };
    // Si no contesta, lanza: el aviso queda fallido y se reintenta. Darlo por
    // entregado sin entregarlo deja un viaje que nunca se enteró.
    await this.urbont.avisar(aviso);
  }
}
