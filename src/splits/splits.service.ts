/**
 * El reparto de un cobro: calcularlo, apuntarlo y pagarlo.
 *
 * El orden de los tres verbos es la parte importante, y es el mismo que en el
 * libro de cobros:
 *
 *  1. **Se calcula** con la función pura (`reparto.ts`), sobre lo que de verdad
 *     se capturó y no sobre lo que alguien diga que se capturó.
 *  2. **Se apunta** en `payments.splits`, con la restricción única que impide
 *     que un beneficiario cobre dos veces del mismo cobro.
 *  3. **Se paga**, una transferencia por beneficiario, con clave de
 *     idempotencia derivada del cobro y del beneficiario.
 *
 * Si el paso 3 se hiciera antes del 2, una transferencia que sale bien y cuya
 * fila no se llega a escribir sería dinero pagado del que no queda rastro, y el
 * siguiente intento la pagaría otra vez. Ese es, literalmente, el hallazgo 04
 * de la auditoría de `urbont-api`.
 *
 * Dos decisiones que conviene saber al leer esto:
 *
 *  · **La parte de la plataforma no se transfiere.** Todo entró en la cuenta de
 *    URBONT al cobrar; repartir es sacar de ahí lo del chofer y lo del valet. La
 *    parte de la plataforma se marca pagada sin mover nada, porque ya está donde
 *    tiene que estar. Es también donde se quedan las comisiones del procesador.
 *  · **Un beneficiario sin cuenta activa deja su parte en `pending`, no en
 *    `failed`.** Es el caso del chofer que todavía no terminó su alta: su dinero
 *    está apuntado y lo cobra cuando active, igual que hoy.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProviderRegistry } from '../providers/provider.registry';
import { EstadoInesperadoError, TransaccionNoEncontradaError } from '../payments/payments.service';
import {
  TRANSACTIONS_REPOSITORY,
  type Transaction,
  type TransactionsRepository,
} from '../ledger/transactions.repository';
import {
  ENTRIES_REPOSITORY,
  type Cuenta,
  type EntriesRepository,
  type NuevoAsiento,
} from '../ledger/entries.repository';
import { PAYEES_REPOSITORY, type PayeesRepository, type TipoDePersona } from '../payees/payees.repository';
import { SPLITS_REPOSITORY, type NuevaParte, type Split, type SplitsRepository } from './splits.repository';
import { calcularReparto, sumaDelReparto, type TipoDeBeneficiario } from './reparto';
import type { Cents, PaymentProvider, ProviderName } from '../providers/provider.port';

/** Quién cobra, y por dónde. */
export interface Beneficiario {
  type: TipoDePersona;
  /** El id de URBONT (uuid del perfil). */
  id: string;
  /**
   * Su cuenta en el procesador, si quien llama la conoce.
   *
   * Se registra **sólo la primera vez**: si esa persona ya tiene cuenta
   * apuntada, manda la apuntada. Ver `payees.repository.ts`.
   */
  payeeRef?: string;
  country?: string;
}

export interface PeticionDeReparto {
  taxCents?: Cents;
  valetCents?: Cents;
  bookingFeeCents?: Cents;
  accessFeeCents?: Cents;
  /** Si no viene, la del servicio. */
  commissionRate?: number;
  driverDeductionCents?: Cents;
  driverDeductionMemo?: string;
  beneficiarios: Beneficiario[];
  /**
   * Modo sombra: calcula el reparto y **no escribe ni mueve nada**.
   *
   * Es como se enciende esto en producción: durante unos días el micro calcula
   * el reparto en sombra, quien llama lo compara con lo que hizo él mismo, y
   * cuando los dos digan lo mismo durante una semana se quita el `dryRun`.
   *
   * No apunta las partes a propósito, y esto importa: una fila `pending` que
   * nadie va a pagar es indistinguible, dos semanas después, de una que alguien
   * tiene que pagar. El día que se quitara el `dryRun`, el motor pagaría viajes
   * que `urbont-api` ya pagó. La comparación vive en el registro de quien
   * llama, que es quien tiene los dos números.
   */
  dryRun?: boolean;
}

export interface ParteLiquidada {
  type: TipoDeBeneficiario;
  beneficiaryId: string | null;
  amountCents: Cents;
  deductionCents: Cents;
  status: Split['status'];
  transferRef: string | null;
  failureCode: string | null;
}

export interface ResultadoDeReparto {
  chargeKey: string;
  transactionId: string;
  capturedCents: Cents;
  dryRun: boolean;
  partes: ParteLiquidada[];
  /** El desglose del cálculo. Sólo cuando se acaba de calcular. */
  detalle?: ReturnType<typeof calcularReparto>['detalle'];
}

const CUENTA_DE: Record<TipoDeBeneficiario, Cuenta> = {
  driver: 'driver_payable',
  valet: 'valet_payable',
  platform: 'platform_revenue',
};

@Injectable()
export class SplitsService {
  private readonly log = new Logger(SplitsService.name);

  constructor(
    private readonly registry: ProviderRegistry,
    @Inject(TRANSACTIONS_REPOSITORY) private readonly transacciones: TransactionsRepository,
    @Inject(SPLITS_REPOSITORY) private readonly partes: SplitsRepository,
    @Inject(PAYEES_REPOSITORY) private readonly beneficiarios: PayeesRepository,
    @Inject(ENTRIES_REPOSITORY) private readonly asientos: EntriesRepository,
    /** La comisión que se aplica si quien llama no pasa una. */
    private readonly comisionPorDefecto: number,
  ) {}

  async liquidar(chargeKey: string, p: PeticionDeReparto): Promise<ResultadoDeReparto> {
    const tx = await this.transacciones.porClaveDeIdempotencia(chargeKey);
    if (!tx) throw new TransaccionNoEncontradaError(chargeKey);

    // No se reparte lo que no ha entrado. Repartir una autorización sería
    // prometer dinero que el banco todavía puede negar.
    if (tx.status !== 'captured') {
      throw new EstadoInesperadoError(
        `Sólo se reparte un cobro capturado; '${tx.status}' no lo es (${chargeKey}).`,
      );
    }

    const reparto = calcularReparto({
      // Lo capturado manda, y sale del libro: quien llama no puede inflarlo.
      capturedCents: tx.amountCents,
      taxCents: p.taxCents,
      valetCents: p.valetCents,
      bookingFeeCents: p.bookingFeeCents,
      accessFeeCents: p.accessFeeCents,
      commissionRate: p.commissionRate ?? this.comisionPorDefecto,
      driverDeductionCents: p.driverDeductionCents,
    });

    // Red de seguridad: si el cálculo no cuadrara con lo capturado, apuntarlo
    // sería escribir dinero inventado en el libro. Preferimos no repartir.
    const suma = sumaDelReparto(reparto);
    if (suma !== tx.amountCents) {
      throw new Error(
        `El reparto de ${chargeKey} suma ${suma} y se capturaron ${tx.amountCents}: no se apunta nada.`,
      );
    }

    const porTipo = new Map<TipoDePersona, Beneficiario>();
    for (const b of p.beneficiarios) porTipo.set(b.type, b);

    const nuevas: NuevaParte[] = reparto.partes.map((parte) => {
      const quien = parte.type === 'platform' ? undefined : porTipo.get(parte.type);
      return {
        beneficiaryType: parte.type,
        beneficiaryId: quien?.id ?? null,
        amountCents: parte.amountCents,
        rate: parte.rate ?? null,
        ...(parte.type === 'driver' && reparto.detalle.driverDeductionCents > 0
          ? {
              deductionCents: reparto.detalle.driverDeductionCents,
              memo: p.driverDeductionMemo ?? 'descuento aplicado por quien llama',
            }
          : {}),
      };
    });

    // Una parte de alguien que no sabemos quién es no se puede pagar nunca. Se
    // apunta igual —el dinero existe y hay que poder explicarlo—, pero avisando.
    for (const n of nuevas) {
      if (n.beneficiaryType !== 'platform' && !n.beneficiaryId) {
        this.log.warn(
          `${chargeKey}: hay ${n.amountCents} centavos para un '${n.beneficiaryType}' del que no vino el id; queda sin beneficiario.`,
        );
      }
    }

    // En sombra se devuelve el cálculo y se acaba aquí: ni partes, ni asientos,
    // ni transferencias. Ver `dryRun` en `PeticionDeReparto`.
    if (p.dryRun) {
      this.log.log(
        `${chargeKey}: reparto EN SOMBRA (${reparto.partes.map((x) => `${x.type}=${x.amountCents}`).join(' ')})`,
      );
      return {
        chargeKey,
        transactionId: tx.id,
        capturedCents: tx.amountCents,
        dryRun: true,
        partes: reparto.partes.map((parte) => ({
          type: parte.type,
          beneficiaryId: parte.type === 'platform' ? null : porTipo.get(parte.type)?.id ?? null,
          amountCents: parte.amountCents,
          deductionCents: parte.type === 'driver' ? reparto.detalle.driverDeductionCents : 0,
          status: 'pending' as const,
          transferRef: null,
          failureCode: null,
        })),
        detalle: reparto.detalle,
      };
    }

    const filas = await this.partes.crearSiNoExisten(tx.id, nuevas);
    await this.asentarElReparto(tx, filas);

    const liquidadas = await this.pagar(chargeKey, tx, filas, porTipo);
    return this.resultado(chargeKey, tx, reparto, liquidadas, false);
  }

  /** El reparto del cobro, tal como esté. Sin recalcular nada. */
  async consultar(chargeKey: string): Promise<ResultadoDeReparto | null> {
    const tx = await this.transacciones.porClaveDeIdempotencia(chargeKey);
    if (!tx) return null;
    const filas = await this.partes.porTransaccion(tx.id);
    if (filas.length === 0) return null;
    // Sin `detalle`: no se recalcula nada, así que no hay desglose que dar. Un
    // desglose inventado a partir de las filas se parecería al de verdad y
    // mentiría en los casos raros, que son los que se consultan.
    return {
      chargeKey,
      transactionId: tx.id,
      capturedCents: tx.amountCents,
      dryRun: false,
      partes: filas.map(aParteLiquidada),
    };
  }

  // ── Pagar ─────────────────────────────────────────────────────────────────

  private async pagar(
    chargeKey: string,
    tx: Transaction,
    filas: Split[],
    porTipo: Map<TipoDePersona, Beneficiario>,
  ): Promise<Split[]> {
    const provider = this.registry.paraCobroExistente(tx.provider);
    const resultado: Split[] = [];

    for (const fila of filas) {
      if (fila.status === 'paid') {
        resultado.push(fila);
        continue;
      }

      // La parte de la plataforma ya está donde tiene que estar: todo entró en
      // su cuenta al cobrar. No hay nada que transferir.
      if (fila.beneficiaryType === 'platform') {
        resultado.push(await this.partes.marcarPagada(fila.id, tx.provider, null));
        continue;
      }

      if (fila.amountCents === 0) {
        resultado.push(await this.partes.marcarPagada(fila.id, tx.provider, null));
        continue;
      }

      const quien = fila.beneficiaryId ? porTipo.get(fila.beneficiaryType as TipoDePersona) : undefined;
      const cuenta = await this.cuentaDeCobro(tx.provider, provider, fila, quien);
      if (!cuenta) {
        // Pendiente, no fallida: su dinero está apuntado y lo cobra cuando
        // termine su alta, igual que hoy.
        resultado.push(fila);
        continue;
      }

      try {
        const transferencia = await provider.transfer({
          idempotencyKey: `${chargeKey}_split_${fila.beneficiaryType}_${fila.beneficiaryId}`,
          payeeRef: cuenta,
          amount: fila.amountCents,
          currency: tx.currency,
          // Ata la transferencia al cargo del que sale. Sin esto falla con
          // `balance_insufficient` en cuanto el payout automático barre el saldo.
          ...(await this.cargoDelCobro(tx, provider)),
          description: `${fila.beneficiaryType} payout for ${tx.kind} ${tx.rideId ?? tx.id}`,
          reference: {
            ...(tx.rideId ? { rideId: tx.rideId } : {}),
            ...(fila.beneficiaryId ? { beneficiaryId: fila.beneficiaryId } : {}),
          },
        });

        const pagada = await this.partes.marcarPagada(fila.id, tx.provider, transferencia.providerRef);
        await this.asentarElPago(tx, pagada);
        this.log.log(
          `${chargeKey}: ${fila.amountCents} centavos al ${fila.beneficiaryType} ${fila.beneficiaryId} (${transferencia.providerRef})`,
        );
        resultado.push(pagada);
      } catch (e) {
        // Que falle el pago de uno no puede dejar sin pagar al otro.
        const codigo = e instanceof Error ? e.message : String(e);
        this.log.error(`${chargeKey}: falló el pago al ${fila.beneficiaryType} ${fila.beneficiaryId}: ${codigo}`);
        resultado.push(await this.partes.marcarFallida(fila.id, codigo));
      }
    }

    return resultado;
  }

  /**
   * La cuenta por la que cobra esta persona, o `null` si todavía no puede
   * cobrar.
   *
   * Manda la tabla, no lo que venga en la petición: registrar es sólo para la
   * primera vez. Y si la cuenta no está activa, se le pregunta al procesador
   * antes de dejar a nadie sin cobrar, porque nuestro estado es una caché.
   */
  private async cuentaDeCobro(
    nombre: ProviderName,
    provider: PaymentProvider,
    fila: Split,
    quien?: Beneficiario,
  ): Promise<string | null> {
    const tipo = fila.beneficiaryType as TipoDePersona;
    if (!fila.beneficiaryId) return null;

    let payee = await this.beneficiarios.porPersona(fila.beneficiaryId, nombre);

    if (!payee && quien?.payeeRef) {
      const { payee: guardado, yaExistia } = await this.beneficiarios.registrarSiFalta({
        payeeId: fila.beneficiaryId,
        payeeType: tipo,
        provider: nombre,
        providerRef: quien.payeeRef,
        country: quien.country,
      });
      payee = guardado;
      if (!yaExistia) {
        this.log.log(`Beneficiario ${fila.beneficiaryId} registrado en ${nombre}: ${quien.payeeRef}`);
      }
    }

    if (!payee) {
      this.log.warn(`${fila.beneficiaryType} ${fila.beneficiaryId} no tiene cuenta en ${nombre}: su parte queda pendiente.`);
      return null;
    }

    if (quien?.payeeRef && quien.payeeRef !== payee.providerRef) {
      // Alguien pidió pagar a una cuenta distinta de la registrada. No se
      // obedece: cambiar la cuenta de cobro es una operación explícita, no un
      // efecto colateral de pagar un viaje.
      this.log.warn(
        `${fila.beneficiaryId} tiene registrada ${payee.providerRef} en ${nombre}, pero la petición traía ${quien.payeeRef}: manda la registrada.`,
      );
    }

    if (payee.status === 'active') return payee.providerRef;

    try {
      const estado = await provider.payeeStatus(payee.providerRef);
      await this.beneficiarios.actualizarEstado(payee.payeeId, nombre, estado);
      if (estado === 'active') return payee.providerRef;
      this.log.warn(
        `${fila.beneficiaryType} ${fila.beneficiaryId} no puede cobrar todavía (${estado}): su parte queda pendiente.`,
      );
    } catch (e) {
      this.log.error(
        `No se pudo comprobar la cuenta de ${fila.beneficiaryId} en ${nombre}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return null;
  }

  /** El cargo que financia las transferencias, releído si no estaba guardado. */
  private async cargoDelCobro(
    tx: Transaction,
    provider: PaymentProvider,
  ): Promise<{ sourceRef?: string }> {
    if (tx.chargeRef) return { sourceRef: tx.chargeRef };
    if (!tx.providerRef) return {};
    try {
      const cobro = await provider.getAuthorization(tx.providerRef);
      return cobro.chargeRef ? { sourceRef: cobro.chargeRef } : {};
    } catch (e) {
      this.log.warn(
        `No se pudo leer el cargo de ${tx.providerRef}: la transferencia saldrá del saldo general (${e instanceof Error ? e.message : String(e)})`,
      );
      return {};
    }
  }

  // ── Libro contable ────────────────────────────────────────────────────────

  private async asentarElReparto(tx: Transaction, filas: Split[]): Promise<void> {
    const asientos: NuevoAsiento[] = [
      {
        entryKey: `${tx.id}:split:clearing`,
        transactionId: tx.id,
        entryType: 'split',
        account: 'clearing',
        amountCents: tx.amountCents,
        currency: tx.currency,
        provider: tx.provider,
        providerRef: tx.chargeRef ?? tx.providerRef,
        memo: `cobro capturado de ${tx.kind}`,
      },
    ];

    for (const fila of filas) {
      asientos.push({
        entryKey: `${tx.id}:split:${CUENTA_DE[fila.beneficiaryType]}`,
        transactionId: tx.id,
        splitId: fila.id,
        entryType: 'split',
        account: CUENTA_DE[fila.beneficiaryType],
        // Negativo: nace la deuda con el beneficiario (o el ingreso de URBONT).
        amountCents: -fila.amountCents,
        currency: tx.currency,
        provider: tx.provider,
        memo: fila.memo,
      });
    }

    await this.asientos.asentar(asientos);
  }

  private async asentarElPago(tx: Transaction, fila: Split): Promise<void> {
    if (fila.amountCents === 0) return;
    await this.asientos.asentar([
      {
        entryKey: `${fila.id}:payout:${CUENTA_DE[fila.beneficiaryType]}`,
        transactionId: tx.id,
        splitId: fila.id,
        entryType: 'payout',
        account: CUENTA_DE[fila.beneficiaryType],
        // La deuda se extingue.
        amountCents: fila.amountCents,
        currency: tx.currency,
        provider: fila.provider,
        providerRef: fila.providerTransferRef,
        memo: `pago al ${fila.beneficiaryType}`,
      },
      {
        entryKey: `${fila.id}:payout:clearing`,
        transactionId: tx.id,
        splitId: fila.id,
        entryType: 'payout',
        account: 'clearing',
        // Y el dinero sale de la cuenta de la plataforma.
        amountCents: -fila.amountCents,
        currency: tx.currency,
        provider: fila.provider,
        providerRef: fila.providerTransferRef,
      },
    ]);
  }

  // ── Presentación ──────────────────────────────────────────────────────────

  private resultado(
    chargeKey: string,
    tx: Transaction,
    reparto: ReturnType<typeof calcularReparto>,
    filas: Split[],
    dryRun: boolean,
  ): ResultadoDeReparto {
    return {
      chargeKey,
      transactionId: tx.id,
      capturedCents: tx.amountCents,
      dryRun,
      partes: filas.map(aParteLiquidada),
      detalle: reparto.detalle,
    };
  }
}

function aParteLiquidada(f: Split): ParteLiquidada {
  return {
    type: f.beneficiaryType,
    beneficiaryId: f.beneficiaryId,
    amountCents: f.amountCents,
    deductionCents: f.deductionCents,
    status: f.status,
    transferRef: f.providerTransferRef,
    failureCode: f.failureCode,
  };
}
