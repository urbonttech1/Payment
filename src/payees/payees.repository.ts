/**
 * La cuenta de cobro de un chofer o de un valet, en cada procesador.
 *
 * Un mismo chofer puede tener cuenta en Stripe y en Adyen a la vez durante una
 * migración, y hay que poder pagarle por la que corresponda al cobro.
 *
 * **Se registra una vez y después manda la tabla.** `registrarSiFalta` no
 * sobreescribe: si la persona ya tiene cuenta en ese procesador, se queda la
 * que había y se devuelve. Es deliberado, y es lo que impide que una petición
 * —aunque venga firmada— redirija el dinero de un beneficiario que ya existe
 * cambiando la cuenta de destino. Cambiarla de verdad es una operación
 * explícita y aparte (`actualizarCuenta`), no un efecto colateral de pagar.
 */

import type { PayeeStatus, ProviderName } from '../providers/provider.port';

export type TipoDePersona = 'driver' | 'valet';

export interface Payee {
  id: string;
  payeeId: string;
  payeeType: TipoDePersona;
  provider: ProviderName;
  providerRef: string;
  status: PayeeStatus;
  country: string;
  checkedAt: Date | null;
}

export interface NuevoPayee {
  payeeId: string;
  payeeType: TipoDePersona;
  provider: ProviderName;
  providerRef: string;
  country?: string;
  status?: PayeeStatus;
}

/**
 * Esa cuenta de cobro ya está registrada a nombre de otra persona.
 *
 * No se arregla en silencio: dos choferes apuntando a la misma cuenta
 * significa que uno de los dos cobraría lo del otro. Quien llama tiene que
 * verlo y corregir el dato de origen.
 */
export class CuentaDeOtraPersonaError extends Error {
  constructor(
    public readonly provider: ProviderName,
    public readonly providerRef: string,
  ) {
    super(`La cuenta ${provider}:${providerRef} ya está registrada a nombre de otra persona`);
    this.name = 'CuentaDeOtraPersonaError';
  }
}

export interface PayeesRepository {
  /**
   * Registra la cuenta si esa persona todavía no tenía una en ese procesador.
   * Devuelve la que vale, que puede no ser la que se pasó.
   */
  registrarSiFalta(nuevo: NuevoPayee): Promise<{ payee: Payee; yaExistia: boolean }>;

  porPersona(payeeId: string, provider: ProviderName): Promise<Payee | null>;

  /** Cambio explícito de cuenta. No lo hace el camino del pago. */
  actualizarCuenta(payeeId: string, provider: ProviderName, providerRef: string): Promise<Payee>;

  actualizarEstado(payeeId: string, provider: ProviderName, status: PayeeStatus): Promise<Payee>;
}

export const PAYEES_REPOSITORY = Symbol('PAYEES_REPOSITORY');
