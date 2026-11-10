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
  | 'manualCapture'
  | 'partialCapture'
  | 'increaseAuthorization'
  | 'savedCards'
  | 'payouts'
  | 'splitAtCapture'
  | 'tapToPay'
  | 'bankDebit'
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

  /**
   * El procesador por defecto, que **puede cambiar en caliente**.
   *
   * Se edita desde el panel, así que no puede quedarse fijado en el arranque:
   * cambiarlo obligaría a redesplegar, que es justo lo que se quita de en
   * medio. El valor del entorno es el inicial y el respaldo.
   */
  private porDefectoActual: ProviderName;

  constructor(
    @Inject(PAYMENT_PROVIDERS) providers: PaymentProvider[],
    defaultProvider: ProviderName,
  ) {
    for (const p of providers) this.porNombre.set(p.name, p);
    this.porDefectoActual = defaultProvider;
    this.log.log(
      `Procesadores registrados: ${[...this.porNombre.keys()].join(', ') || '(ninguno)'} · por defecto: ${defaultProvider}`,
    );
  }

  /** Cuál atiende los cobros nuevos ahora mismo. */
  get porDefecto(): ProviderName {
    return this.porDefectoActual;
  }

  /**
   * Cambia el procesador de los cobros nuevos.
   *
   * No toca ningún cobro existente: la regla 1 sigue mandando y cada cobro
   * vuelve al procesador que lo originó. Lo que cambia es a partir de cuándo.
   *
   * Se niega a elegir uno que no esté montado: dejar el servicio apuntando a un
   * procesador sin credenciales convertiría todos los cobros nuevos en un error,
   * y el panel no tendría forma de volver atrás.
   */
  fijarPorDefecto(nombre: ProviderName): void {
    if (nombre === this.porDefectoActual) return;
    const p = this.porNombre.get(nombre);
    if (!p) {
      throw new ProviderNotAvailableError(
        `No se puede poner '${nombre}' por defecto: no está montado. Disponibles: ${this.disponibles().join(', ') || 'ninguno'}.`,
      );
    }
    const antes = this.porDefectoActual;
    this.porDefectoActual = nombre;
    this.log.warn(`Los cobros NUEVOS pasan de '${antes}' a '${nombre}'. Los existentes siguen en el suyo.`);
  }

  /**
   * Monta (o reemplaza) un procesador en caliente.
   *
   * Es lo que permite pegar las credenciales de una pasarela en el panel y que
   * cobre acto seguido, sin redesplegar. Reemplazar es a propósito: cambiar una
   * clave caducada por la nueva es exactamente eso.
   */
  montar(provider: PaymentProvider): void {
    const reemplaza = this.porNombre.has(provider.name);
    this.porNombre.set(provider.name, provider);
    this.log.log(`Procesador '${provider.name}' ${reemplaza ? 'reemplazado' : 'montado'} en caliente.`);
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
    const porDefecto = this.porNombre.get(this.porDefectoActual);
    if (porDefecto && necesita.every((c) => porDefecto.capabilities[c])) return porDefecto;

    for (const p of this.porNombre.values()) {
      if (necesita.every((c) => p.capabilities[c])) {
        if (porDefecto) {
          this.log.warn(
            `'${this.porDefectoActual}' no puede con [${necesita.join(', ')}]; se usa '${p.name}'.`,
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
