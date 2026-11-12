/**
 * Los pagos que hace una persona, no un procesador.
 *
 * Con Square el dinero entra entero en la cuenta de URBONT: el procesador no
 * sabe pagarle a terceros. El reparto deja de ser un movimiento y pasa a ser un
 * apunte —lo que se le debe a cada chofer y a cada valet—, y alguien transfiere
 * desde el banco una o dos veces por semana y lo marca aquí.
 *
 * Tres reglas, y cada una tapa una forma concreta de perder dinero:
 *
 *  1. **El importe no viene de fuera.** Quien paga dice a quién y con qué
 *     comprobante; cuánto lo dice el libro. Es la misma regla que gobierna el
 *     resto del servicio, y aquí importa más: un importe editable en el panel
 *     es un panel que puede regalar dinero.
 *  2. **Registrar el pago y saldar las partes es atómico.** Partido por la
 *     mitad, o se paga dos veces o se borra una deuda sin dejar rastro.
 *  3. **Los datos bancarios se guardan cifrados y no se devuelven.** El panel
 *     ve los últimos dígitos y el titular. El número completo sale por una
 *     ruta aparte, la del momento de transferir, y esa queda registrada.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG, type Config } from '../config/config';
import { cifrar, claveMaestra, descifrar, hayClaveMaestra } from '../config/cifrado';
import { SPLITS_REPOSITORY, type SplitsRepository } from '../splits/splits.repository';
import type { TipoDeBeneficiario } from '../splits/reparto';
import {
  PAYOUTS_REPOSITORY,
  PAYOUT_ACCOUNTS_REPOSITORY,
  type CuentaParaElPanel,
  type DatosBancarios,
  type MetodoDePago,
  type MetodoDeTransferencia,
  type PagoRegistrado,
  type Payout,
  type PayoutAccountsRepository,
  type PayoutsRepository,
} from './payouts.repository';

/** Lo que el panel enseña por persona: lo que se le debe y dónde cobrarlo. */
export interface SaldoConCuenta {
  payeeType: TipoDeBeneficiario;
  payeeId: string;
  totalCents: number;
  partesPendientes: number;
  desde: Date;
  hasta: Date;
  /** `null` si todavía no registró dónde cobrar: no se le puede pagar. */
  cuenta: CuentaParaElPanel | null;
}

export class SinCuentaDeCobroError extends Error {
  constructor(payeeId: string) {
    super(`No se le puede pagar a ${payeeId}: no tiene cuenta de cobro registrada.`);
    this.name = 'SinCuentaDeCobroError';
  }
}

export class NadaQuePagarError extends Error {
  constructor(payeeId: string) {
    super(`${payeeId} no tiene nada pendiente de cobro.`);
    this.name = 'NadaQuePagarError';
  }
}

export class SinCifradoError extends Error {
  constructor() {
    super('CREDENTIALS_KEY no está configurada: no se pueden guardar ni leer datos bancarios.');
    this.name = 'SinCifradoError';
  }
}

@Injectable()
export class PayoutsService {
  private readonly log = new Logger(PayoutsService.name);

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(SPLITS_REPOSITORY) private readonly partes: SplitsRepository,
    @Inject(PAYOUT_ACCOUNTS_REPOSITORY) private readonly cuentas: PayoutAccountsRepository,
    @Inject(PAYOUTS_REPOSITORY) private readonly pagos: PayoutsRepository,
  ) {}

  // ── Lo que se debe ────────────────────────────────────────────────────────

  /**
   * El acumulado de cada persona con su cuenta de cobro al lado.
   *
   * Se devuelve también a quien no tiene cuenta registrada, con `cuenta: null`.
   * Esconderlo sería peor: esa persona tiene dinero esperando y nadie se
   * enteraría de que falta un dato suyo.
   */
  async saldos(): Promise<SaldoConCuenta[]> {
    const [saldos, cuentas] = await Promise.all([this.partes.saldos(), this.cuentas.listar()]);
    const porPersona = new Map(cuentas.map((c) => [c.payeeId, c]));

    return saldos.map((s) => ({
      payeeType: s.payeeType,
      payeeId: s.payeeId,
      totalCents: s.totalCents,
      partesPendientes: s.partesPendientes,
      desde: s.desde,
      hasta: s.hasta,
      cuenta: porPersona.get(s.payeeId) ?? null,
    }));
  }

  // ── Dónde cobra cada uno ──────────────────────────────────────────────────

  listarCuentas(): Promise<CuentaParaElPanel[]> {
    return this.cuentas.listar();
  }

  async registrarCuenta(
    payeeId: string,
    payeeType: TipoDeBeneficiario,
    method: MetodoDePago,
    holderName: string,
    datos: DatosBancarios,
    quien: string,
    bankName?: string,
  ): Promise<CuentaParaElPanel> {
    if (!hayClaveMaestra(this.config.CREDENTIALS_KEY)) throw new SinCifradoError();
    this.validar(method, datos, holderName);

    const clave = claveMaestra(this.config.CREDENTIALS_KEY);
    const cuenta = await this.cuentas.guardar(
      { payeeId, payeeType, method, holderName, bankName, datos },
      cifrar(JSON.stringify(datos), clave),
      this.pistaDe(method, datos),
      quien,
    );

    // Se registra el cambio, nunca el dato. Si alguien desvía los pagos de un
    // chofer a otra cuenta, esta línea es lo que lo delata.
    this.log.warn(`Cuenta de cobro de ${payeeType} ${payeeId} actualizada por ${quien} (${cuenta.pista}).`);
    return cuenta;
  }

  /**
   * Los datos bancarios en claro, para el momento de hacer la transferencia.
   *
   * Es la única puerta por la que salen, y deja rastro de quién los pidió. No
   * se llama al pintar la lista: se llama cuando alguien va a pagar.
   */
  async datosParaTransferir(payeeId: string, quien: string): Promise<DatosBancarios> {
    if (!hayClaveMaestra(this.config.CREDENTIALS_KEY)) throw new SinCifradoError();
    const cifrado = await this.cuentas.secretoDe(payeeId);
    if (!cifrado) throw new SinCuentaDeCobroError(payeeId);

    this.log.warn(`${quien} consultó los datos bancarios de ${payeeId}.`);
    return JSON.parse(descifrar(cifrado, claveMaestra(this.config.CREDENTIALS_KEY))) as DatosBancarios;
  }

  verificarCuenta(payeeId: string, quien: string): Promise<CuentaParaElPanel> {
    return this.cuentas.cambiarEstado(payeeId, 'verified', null, quien);
  }

  rechazarCuenta(payeeId: string, motivo: string, quien: string): Promise<CuentaParaElPanel> {
    return this.cuentas.cambiarEstado(payeeId, 'rejected', motivo, quien);
  }

  // ── Pagar ─────────────────────────────────────────────────────────────────

  /**
   * Registra que ya se le transfirió a alguien todo lo que se le debía.
   *
   * **El importe lo decide el libro, no quien llama.** Se saldan las partes que
   * estén pendientes en este instante y el pago vale exactamente su suma. Si
   * entre que el panel pintó el saldo y alguien pulsó el botón entró un viaje
   * nuevo, se paga también: es dinero que se le debe igual.
   */
  async pagar(
    payeeId: string,
    method: MetodoDeTransferencia,
    quien: string,
    opciones: { reference?: string; notes?: string } = {},
  ): Promise<PagoRegistrado> {
    const cuenta = await this.cuentas.obtener(payeeId);
    if (!cuenta) throw new SinCuentaDeCobroError(payeeId);

    const pendientes = await this.partes.pendientesDe(cuenta.payeeType, payeeId);
    if (pendientes.length === 0) throw new NadaQuePagarError(payeeId);

    const total = pendientes.reduce((a, p) => a + p.amountCents, 0);
    const fechas = pendientes.map((p) => p.createdAt.getTime());

    const registrado = await this.pagos.pagarYSaldar(
      {
        payeeId,
        payeeType: cuenta.payeeType,
        amountCents: total,
        currency: 'USD',
        method,
        reference: opciones.reference,
        notes: opciones.notes,
        periodStart: new Date(Math.min(...fechas)),
        periodEnd: new Date(Math.max(...fechas)),
        createdBy: quien,
      },
      pendientes.map((p) => p.id),
    );

    this.log.warn(
      `${quien} pagó ${total} centavos al ${cuenta.payeeType} ${payeeId} ` +
        `(${registrado.partesSaldadas} partes, ${method}, ref ${opciones.reference ?? 'sin comprobante'}).`,
    );
    return registrado;
  }

  historial(payeeId: string, limite = 50): Promise<Payout[]> {
    return this.pagos.historial(payeeId, limite);
  }

  recientes(limite = 50): Promise<Payout[]> {
    return this.pagos.recientes(limite);
  }

  // ── Interno ───────────────────────────────────────────────────────────────

  private validar(method: MetodoDePago, datos: DatosBancarios, holderName: string): void {
    if (!holderName.trim()) throw new Error('Falta el nombre del titular de la cuenta.');

    if (method === 'ach') {
      const routing = (datos.routingNumber ?? '').replace(/\D/g, '');
      const cuenta = (datos.accountNumber ?? '').replace(/\D/g, '');
      // Nueve dígitos no es un capricho: un ABA mal tecleado hace que la
      // transferencia se rechace días después, cuando ya nadie se acuerda.
      if (routing.length !== 9) throw new Error('El número de ruta (routing) tiene que tener 9 dígitos.');
      if (cuenta.length < 4) throw new Error('El número de cuenta no parece válido.');
      return;
    }

    if (!(datos.zelleEmail ?? '').trim()) throw new Error('Falta el correo o teléfono de Zelle.');
  }

  /** Lo único que se enseña de la cuenta. */
  private pistaDe(method: MetodoDePago, datos: DatosBancarios): string {
    if (method === 'ach') {
      const n = (datos.accountNumber ?? '').replace(/\D/g, '');
      return `****${n.slice(-4)}`;
    }
    const z = (datos.zelleEmail ?? '').trim();
    // Se enmascara el medio: suficiente para reconocerlo, no para usarlo.
    const [usuario, dominio] = z.split('@');
    if (!dominio) return `${z.slice(0, 2)}***${z.slice(-2)}`;
    return `${usuario.slice(0, 2)}***@${dominio}`;
  }
}
