/**
 * Qué procesador atiende cada operación.
 *
 * Dos reglas, y la primera manda sobre la segunda:
 *
 *  1. **Una operación sobre un cobro existente va siempre al procesador que lo
 *     originó.** Capturar, reembolsar o disputar un cobro de Stripe sigue yendo
 *     a Stripe aunque el procesador por defecto ya sea otro. Sin esta regla, un
 *     cambio de proveedor rompería los cobros vivos y las disputas, que tardan
 *     hasta 120 días en cerrarse.
 *  2. **Un cobro nuevo va al procesador por defecto**, salvo que la operación
 *     exija algo que ese procesador no sepa hacer; entonces va al primero de la
 *     lista que sí sepa.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  PAYMENT_PROVIDERS,
  type PaymentProvider,
  type ProviderCapabilities,
  type ProviderName,
} from './provider.port';

/** Una capacidad concreta que una operación necesita del procesador. */
export type CapabilityNeeded = keyof Pick<
  ProviderCapabilities,
  'manualCapture' | 'partialCapture' | 'savedCards' | 'payouts' | 'splitAtCapture' | 'tapToPay' | 'bankDebit'
>;

export class ProviderNotAvailableError extends Error {
  constructor(public readonly detail: string) {
    super(detail);
    this.name = 'ProviderNotAvailableError';
  }
}

@Injectable()
export class ProviderRegistry {
  private readonly log = new Logger(ProviderRegistry.name);
  private readonly porNombre = new Map<ProviderName, PaymentProvider>();

  constructor(
    @Inject(PAYMENT_PROVIDERS) providers: PaymentProvider[],
    private readonly defaultProvider: ProviderName,
  ) {
    for (const p of providers) this.porNombre.set(p.name, p);
    this.log.log(
      `Procesadores registrados: ${[...this.porNombre.keys()].join(', ') || '(ninguno)'} · por defecto: ${defaultProvider}`,
    );
  }

  /** Los que están montados ahora mismo. */
  disponibles(): ProviderName[] {
    return [...this.porNombre.keys()];
  }

  /** El procesador con ese nombre, o un error que dice cuáles hay. */
  porNombreExacto(name: ProviderName): PaymentProvider {
    const p = this.porNombre.get(name);
    if (!p) {
      throw new ProviderNotAvailableError(
        `El procesador '${name}' no está montado. Disponibles: ${this.disponibles().join(', ') || 'ninguno'}.`,
      );
    }
    return p;
  }

  /**
   * El procesador que debe atender una operación sobre un cobro YA existente.
   * Regla 1: el que lo originó, sin excepciones.
   */
  paraCobroExistente(provider: ProviderName): PaymentProvider {
    return this.porNombreExacto(provider);
  }

  /**
   * El procesador para un cobro nuevo.
   *
   * Con `necesita`, se salta al por defecto si éste no sabe hacerlo y usa el
   * primero que sí. Sin nadie capaz, falla diciendo qué faltaba.
   */
  paraCobroNuevo(necesita: CapabilityNeeded[] = []): PaymentProvider {
    const porDefecto = this.porNombre.get(this.defaultProvider);
    if (porDefecto && necesita.every((c) => porDefecto.capabilities[c])) return porDefecto;

    for (const p of this.porNombre.values()) {
      if (necesita.every((c) => p.capabilities[c])) {
        if (porDefecto) {
          this.log.warn(
            `'${this.defaultProvider}' no puede con [${necesita.join(', ')}]; se usa '${p.name}'.`,
          );
        }
        return p;
      }
    }

    throw new ProviderNotAvailableError(
      necesita.length > 0
        ? `Ningún procesador montado puede con [${necesita.join(', ')}]. Disponibles: ${this.disponibles().join(', ') || 'ninguno'}.`
        : `No hay ningún procesador montado.`,
    );
  }
}
