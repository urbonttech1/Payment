/**
 * El libro contable por partida doble.
 *
 * Sólo inserciones: un asiento no se corrige, se compensa con otro. Es lo que
 * permite responder «de dónde salió este dinero» seis meses después, cuando ya
 * nadie se acuerda y el procesador sólo sabe de sus propios identificadores.
 *
 * La regla es una sola, y las pruebas la comprueban: **los asientos de un cobro
 * suman cero.** Si suman otra cosa, hay dinero inventado o perdido en el
 * registro, y a partir de ahí ningún cuadre sirve.
 *
 * Las cuentas que se usan:
 *
 *  · `clearing`         — el dinero del procesador a nuestro favor.
 *  · `driver_payable`   — lo que se le debe al chofer.
 *  · `valet_payable`    — lo que se le debe al valet.
 *  · `platform_revenue` — lo que se queda URBONT, impuesto incluido.
 *
 * Al capturar: entra en `clearing` y se reparte como deuda entre los tres. Al
 * pagar: la deuda se extingue y sale de `clearing`. Lo que quede en `clearing`
 * al final es lo que de verdad se queda en la cuenta de la plataforma.
 */

import type { Cents, Currency, ProviderName } from '../providers/provider.port';

export type Cuenta = 'clearing' | 'driver_payable' | 'valet_payable' | 'platform_revenue';

export type TipoDeAsiento = 'capture' | 'split' | 'payout' | 'refund' | 'adjustment';

export interface NuevoAsiento {
  /**
   * Identidad lógica del asiento. Dos intentos del mismo reparto traen la misma
   * clave, y el segundo no escribe nada.
   */
  entryKey: string;
  transactionId: string;
  splitId?: string | null;
  entryType: TipoDeAsiento;
  account: Cuenta;
  /** Con signo: positivo entra en la cuenta, negativo sale. */
  amountCents: Cents;
  currency?: Currency;
  provider?: ProviderName | null;
  providerRef?: string | null;
  memo?: string | null;
}

export interface Asiento extends NuevoAsiento {
  id: string;
  occurredAt: Date;
}

export interface EntriesRepository {
  /** Apunta los asientos que falten. Los que ya estaban no se duplican. */
  asentar(asientos: NuevoAsiento[]): Promise<number>;

  porTransaccion(transactionId: string): Promise<Asiento[]>;

  /** El saldo de cada cuenta en ese cobro. La suma de todos tiene que ser 0. */
  saldos(transactionId: string): Promise<Record<string, Cents>>;
}

export const ENTRIES_REPOSITORY = Symbol('ENTRIES_REPOSITORY');
