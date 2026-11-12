/**
 * Lo que hace falta para pagarle a una persona a mano.
 *
 * Dos cosas, y son distintas a propósito:
 *
 *  · **Dónde cobra** (`PayoutAccountsRepository`) — su cuenta bancaria o su
 *    Zelle. Se registra una vez y después manda la registrada. Cambiarla es una
 *    operación explícita, no un efecto colateral de pagar un viaje. Es la misma
 *    regla que ya gobierna `payees`, y por el mismo motivo: el destino del
 *    dinero no puede moverse por una petición cualquiera.
 *
 *  · **Qué se le pagó** (`PayoutsRepository`) — una fila por transferencia de
 *    verdad, con el comprobante del banco. Sin eso, un pago discutido seis
 *    meses después no se puede demostrar.
 *
 * Los datos bancarios se guardan **cifrados** con la misma clave maestra que
 * las credenciales de las pasarelas, y por el mismo motivo: un volcado de la
 * base no puede ser una lista de cuentas bancarias.
 */

import type { Cents } from '../providers/provider.port';
import type { TipoDeBeneficiario } from '../splits/reparto';

/** Por dónde se le paga a alguien. */
export type MetodoDePago = 'ach' | 'zelle';

/** Cómo se hizo un pago concreto. Incluye los que no son electrónicos. */
export type MetodoDeTransferencia = MetodoDePago | 'cash' | 'other';

export type EstadoDeCuenta = 'pending' | 'verified' | 'rejected';

/**
 * Los datos bancarios en claro.
 *
 * Este tipo **sólo** existe dentro del servicio, entre descifrar y usar. No
 * sale por ninguna ruta de listado: lo que el panel ve es `CuentaParaElPanel`.
 */
export interface DatosBancarios {
  /** ACH: el número de ruta de 9 dígitos. */
  routingNumber?: string;
  /** ACH: el número de cuenta. */
  accountNumber?: string;
  /** Zelle: el correo o teléfono registrado. */
  zelleEmail?: string;
}

/** Lo que se enseña de una cuenta. Sin el número completo, nunca. */
export interface CuentaParaElPanel {
  payeeId: string;
  payeeType: TipoDeBeneficiario;
  method: MetodoDePago;
  holderName: string;
  bankName: string | null;
  /** Lo único que se ve del número: `****4821`. */
  pista: string;
  status: EstadoDeCuenta;
  statusReason: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}

export interface NuevaCuenta {
  payeeId: string;
  payeeType: TipoDeBeneficiario;
  method: MetodoDePago;
  holderName: string;
  bankName?: string | null;
  datos: DatosBancarios;
}

export interface PayoutAccountsRepository {
  listar(): Promise<CuentaParaElPanel[]>;
  obtener(payeeId: string): Promise<CuentaParaElPanel | null>;

  /**
   * El secreto cifrado tal cual está guardado, para que lo descifre el
   * servicio. El repositorio no conoce la clave maestra.
   */
  secretoDe(payeeId: string): Promise<string | null>;

  guardar(cuenta: NuevaCuenta, secretoCifrado: string, pista: string, quien: string): Promise<CuentaParaElPanel>;

  cambiarEstado(payeeId: string, estado: EstadoDeCuenta, motivo: string | null, quien: string): Promise<CuentaParaElPanel>;
}

// ── Los pagos hechos ────────────────────────────────────────────────────────

export interface Payout {
  id: string;
  payeeId: string;
  payeeType: TipoDeBeneficiario;
  amountCents: Cents;
  currency: string;
  method: MetodoDeTransferencia;
  reference: string | null;
  notes: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  paidAt: Date;
  createdBy: string;
  /** El justificante de la transferencia, para que le llegue al cobrador. */
  documentPath: string | null;
}

export interface NuevoPago {
  payeeId: string;
  payeeType: TipoDeBeneficiario;
  amountCents: Cents;
  currency: string;
  method: MetodoDeTransferencia;
  reference?: string | null;
  notes?: string | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  createdBy: string;
  /** La ruta del justificante en el almacenamiento, si quien pagó subió uno. */
  documentPath?: string | null;
}

/** El resultado de registrar un pago: qué se saldó con él. */
export interface PagoRegistrado {
  pago: Payout;
  /** Cuántas partes del reparto quedaron saldadas. */
  partesSaldadas: number;
}

export class ImporteNoCuadraError extends Error {
  constructor(
    public readonly esperadoCents: Cents,
    public readonly saldadoCents: Cents,
  ) {
    super(
      `El pago no cuadra con lo que se iba a saldar: se pidió pagar ${esperadoCents} centavos ` +
        `y las partes suman ${saldadoCents}. No se guardó nada.`,
    );
    this.name = 'ImporteNoCuadraError';
  }
}

export interface PayoutsRepository {
  /**
   * Registra un pago y salda sus partes **en una sola transacción**.
   *
   * Tiene que ser atómico y no dos operaciones seguidas, porque los dos modos
   * de partirse hacen daño en direcciones opuestas:
   *
   *  · pago guardado y partes sin saldar → la semana que viene se le vuelve a
   *    pagar lo mismo;
   *  · partes saldadas y pago sin guardar → se le debe dinero a alguien y no
   *    queda rastro de por qué dejó de debérsele.
   *
   * Si el importe saldado no coincide con el del pago —porque otra sesión
   * saldó una de esas partes mientras tanto— no se guarda nada y se lanza
   * `ImporteNoCuadraError`. Quien lo vea vuelve a mirar el saldo, que habrá
   * cambiado.
   *
   * Asienta además el pago en el libro, con las mismas dos entradas que un
   * pago del procesador: se extingue la deuda y sale el dinero de la cuenta de
   * la plataforma.
   */
  pagarYSaldar(pago: NuevoPago, splitIds: string[]): Promise<PagoRegistrado>;

  historial(payeeId: string, limite: number): Promise<Payout[]>;
  recientes(limite: number): Promise<Payout[]>;
}

export const PAYOUT_ACCOUNTS_REPOSITORY = Symbol('PAYOUT_ACCOUNTS_REPOSITORY');
export const PAYOUTS_REPOSITORY = Symbol('PAYOUTS_REPOSITORY');
