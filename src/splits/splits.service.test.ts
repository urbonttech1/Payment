/**
 * El reparto, con el libro y los beneficiarios en memoria.
 *
 * Los dobles imitan la restricción que de verdad importa —una parte por
 * beneficiario y por cobro—, igual que la imita el del libro de cobros. Que la
 * base la hace cumplir de verdad lo comprueba `scripts/prueba-reparto.ts`
 * contra Postgres; aquí se comprueba que el servicio se comporta bien **cuando**
 * la restricción existe.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderRegistry } from '../providers/provider.registry';
import type { PaymentProvider, ProviderCapabilities, ProviderName } from '../providers/provider.port';
import { EstadoInesperadoError, TransaccionNoEncontradaError } from '../payments/payments.service';
import type { Transaction, TransactionsRepository } from '../ledger/transactions.repository';
import type { Asiento, EntriesRepository, NuevoAsiento } from '../ledger/entries.repository';
import type { NuevoPayee, Payee, PayeesRepository } from '../payees/payees.repository';
import type { NuevaParte, Split, SplitsRepository } from './splits.repository';
import { SplitsService } from './splits.service';

const CLAVE = 'ride_abc_authorize';
const CHOFER = '11111111-1111-4111-8111-111111111111';
const VALET = '22222222-2222-4222-8222-222222222222';

// ── Dobles ──────────────────────────────────────────────────────────────────

class LibroDeCobros implements TransactionsRepository {
  constructor(public tx: Transaction | null) {}
  async crearSiNoExiste(): Promise<never> { throw new Error('no se usa'); }
  async porId(): Promise<Transaction | null> { return this.tx; }
  async porClaveDeIdempotencia(clave: string): Promise<Transaction | null> {
    return this.tx && this.tx.idempotencyKey === clave ? this.tx : null;
  }
  async porReferenciaDelProveedor(): Promise<Transaction | null> { return this.tx; }
  async marcarAutorizada(): Promise<Transaction> { throw new Error('no se usa'); }
  async marcarCapturada(): Promise<Transaction> { throw new Error('no se usa'); }
  async marcarFallida(): Promise<Transaction> { throw new Error('no se usa'); }
  async marcarAnulada(): Promise<Transaction> { throw new Error('no se usa'); }
  async marcarReembolsada(): Promise<Transaction> { throw new Error('no se usa'); }
}

class RepartoEnMemoria implements SplitsRepository {
  filas: Split[] = [];
  private n = 0;

  async crearSiNoExisten(transactionId: string, partes: NuevaParte[]): Promise<Split[]> {
    for (const p of partes) {
      const clave = `${transactionId}|${p.beneficiaryType}|${p.beneficiaryId ?? ''}`;
      // La restricción única de la base, imitada: lo que ya está no se toca.
      if (this.filas.some((f) => `${f.transactionId}|${f.beneficiaryType}|${f.beneficiaryId ?? ''}` === clave)) continue;
      this.filas.push({
        id: `split-${++this.n}`,
        transactionId,
        beneficiaryType: p.beneficiaryType,
        beneficiaryId: p.beneficiaryId ?? null,
        amountCents: p.amountCents,
        deductionCents: p.deductionCents ?? 0,
        rate: p.rate ?? null,
        status: 'pending',
        provider: null,
        providerTransferRef: null,
        failureCode: null,
        memo: p.memo ?? null,
        paidAt: null,
        createdAt: new Date(),
      });
    }
    return this.porTransaccion(transactionId);
  }

  async porTransaccion(transactionId: string): Promise<Split[]> {
    return this.filas
      .filter((f) => f.transactionId === transactionId)
      .sort((a, b) => a.beneficiaryType.localeCompare(b.beneficiaryType));
  }

  async marcarPagada(id: string, provider: ProviderName, ref: string | null): Promise<Split> {
    return this.set(id, { status: 'paid', provider, providerTransferRef: ref, paidAt: new Date() });
  }
  async marcarFallida(id: string, codigo: string): Promise<Split> {
    return this.set(id, { status: 'failed', failureCode: codigo });
  }
  private set(id: string, cambios: Partial<Split>): Split {
    const i = this.filas.findIndex((f) => f.id === id);
    if (i < 0) throw new Error(`no existe ${id}`);
    this.filas[i] = { ...this.filas[i], ...cambios };
    return this.filas[i];
  }
}

class BeneficiariosEnMemoria implements PayeesRepository {
  filas: Payee[] = [];
  async registrarSiFalta(n: NuevoPayee): Promise<{ payee: Payee; yaExistia: boolean }> {
    const existente = await this.porPersona(n.payeeId, n.provider);
    if (existente) return { payee: existente, yaExistia: true };
    const payee: Payee = {
      id: `payee-${this.filas.length + 1}`,
      payeeId: n.payeeId,
      payeeType: n.payeeType,
      provider: n.provider,
      providerRef: n.providerRef,
      status: n.status ?? 'pending',
      country: n.country ?? 'US',
      checkedAt: null,
    };
    this.filas.push(payee);
    return { payee, yaExistia: false };
  }
  async porPersona(payeeId: string, provider: ProviderName): Promise<Payee | null> {
    return this.filas.find((f) => f.payeeId === payeeId && f.provider === provider) ?? null;
  }
  async porReferencia(provider: ProviderName, providerRef: string): Promise<Payee | null> {
    return this.filas.find((f) => f.provider === provider && f.providerRef === providerRef) ?? null;
  }
  async actualizarCuenta(payeeId: string, provider: ProviderName, providerRef: string): Promise<Payee> {
    return this.set(payeeId, provider, { providerRef, status: 'pending' });
  }
  async actualizarEstado(payeeId: string, provider: ProviderName, status: Payee['status']): Promise<Payee> {
    return this.set(payeeId, provider, { status, checkedAt: new Date() });
  }
  private set(payeeId: string, provider: ProviderName, cambios: Partial<Payee>): Payee {
    const i = this.filas.findIndex((f) => f.payeeId === payeeId && f.provider === provider);
    if (i < 0) throw new Error(`no hay beneficiario ${payeeId}`);
    this.filas[i] = { ...this.filas[i], ...cambios };
    return this.filas[i];
  }
}

class LibroContableEnMemoria implements EntriesRepository {
  asientosPorClave = new Map<string, NuevoAsiento>();
  async asentar(asientos: NuevoAsiento[]): Promise<number> {
    let nuevos = 0;
    for (const a of asientos) {
      // El índice único de `entry_key`, imitado: un reintento no duplica.
      if (this.asientosPorClave.has(a.entryKey)) continue;
      this.asientosPorClave.set(a.entryKey, a);
      nuevos++;
    }
    return nuevos;
  }
  async porTransaccion(): Promise<Asiento[]> { throw new Error('no se usa'); }
  async saldos(): Promise<Record<string, number>> {
    const saldos: Record<string, number> = {};
    for (const a of this.asientosPorClave.values()) {
      saldos[a.account] = (saldos[a.account] ?? 0) + a.amountCents;
    }
    return saldos;
  }
  total(): number {
    return [...this.asientosPorClave.values()].reduce((t, a) => t + a.amountCents, 0);
  }
}

const capacidades = (): ProviderCapabilities => ({
  manualCapture: true, partialCapture: true, increaseAuthorization: true, savedCards: true,
  payouts: true, splitAtCapture: false, tapToPay: false, bankDebit: false, currencies: ['USD'],
});

function proveedorFalso() {
  let n = 0;
  return {
    name: 'stripe' as ProviderName,
    capabilities: capacidades(),
    transfer: vi.fn(async (cmd: { payeeRef: string; amount: number }) => ({
      providerRef: `tr_${++n}`, provider: 'stripe' as ProviderName,
      amount: cmd.amount, currency: 'USD' as const, payeeRef: cmd.payeeRef,
    })),
    payeeStatus: vi.fn(async () => 'active' as const),
    getAuthorization: vi.fn(async (ref: string) => ({
      providerRef: ref, provider: 'stripe' as ProviderName, status: 'captured' as const,
      amount: 11715, currency: 'USD' as const, chargeRef: 'ch_releido',
    })),
  } as unknown as PaymentProvider & {
    transfer: ReturnType<typeof vi.fn>;
    payeeStatus: ReturnType<typeof vi.fn>;
    getAuthorization: ReturnType<typeof vi.fn>;
  };
}

function cobroCapturado(cambios: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1',
    idempotencyKey: CLAVE,
    provider: 'stripe',
    providerRef: 'pi_1',
    chargeRef: 'ch_1',
    kind: 'ride',
    rideId: 'b0a1c2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    payerId: null,
    amountCents: 11715,
    taxCents: 715,
    currency: 'USD',
    status: 'captured',
    authorizedAt: new Date(),
    capturedAt: new Date(),
    failedAt: null,
    failureCode: null,
    createdAt: new Date(),
    ...cambios,
  };
}

// El viaje de referencia: $110 de precio, $7.15 de impuesto, $10 de valet,
// $2.50 de booking y $10 de aeropuerto, al 15 %. Los números son los de la
// tabla de `reparto.test.ts`, que salen de lo que reparte urbont-api hoy.
const PETICION = {
  taxCents: 715,
  valetCents: 1000,
  bookingFeeCents: 250,
  accessFeeCents: 1000,
  commissionRate: 0.15,
  beneficiarios: [
    { type: 'driver' as const, id: CHOFER, payeeRef: 'acct_chofer' },
    { type: 'valet' as const, id: VALET, payeeRef: 'acct_valet' },
  ],
};

describe('SplitsService', () => {
  let libro: LibroDeCobros;
  let partes: RepartoEnMemoria;
  let personas: BeneficiariosEnMemoria;
  let contable: LibroContableEnMemoria;
  let stripe: ReturnType<typeof proveedorFalso>;
  let servicio: SplitsService;

  beforeEach(() => {
    libro = new LibroDeCobros(cobroCapturado());
    partes = new RepartoEnMemoria();
    personas = new BeneficiariosEnMemoria();
    contable = new LibroContableEnMemoria();
    stripe = proveedorFalso();
    servicio = new SplitsService(
      new ProviderRegistry([stripe], 'stripe'), libro, partes, personas, contable, 0.15,
    );
  });

  describe('el reparto', () => {
    it('reparte lo capturado entre chofer, valet y plataforma', async () => {
      const r = await servicio.liquidar(CLAVE, PETICION);

      expect(r.partes.map((p) => [p.type, p.amountCents])).toEqual([
        ['driver', 7400],
        ['platform', 3315],
        ['valet', 1000],
      ]);
      expect(r.partes.reduce((t, p) => t + p.amountCents, 0)).toBe(11715);
    });

    // Lo capturado sale del libro, no de la petición: es la garantía de que
    // nadie puede repartir más dinero del que entró.
    it('ignora cualquier importe que venga en la petición', async () => {
      const r = await servicio.liquidar(CLAVE, {
        ...PETICION,
        ...({ capturedCents: 99_999_999 } as object),
      });
      expect(r.capturedCents).toBe(11715);
    });

    it('usa la comisión del servicio si la petición no trae una', async () => {
      const r = await servicio.liquidar(CLAVE, { ...PETICION, commissionRate: undefined });
      expect(r.detalle?.commissionRate).toBe(0.15);
    });

    it('no reparte un cobro que no existe', async () => {
      await expect(servicio.liquidar('ride_otro_authorize', PETICION)).rejects.toThrow(TransaccionNoEncontradaError);
    });

    it('NO REPARTE UNA AUTORIZACIÓN: sólo lo capturado', async () => {
      libro.tx = cobroCapturado({ status: 'authorized' });
      await expect(servicio.liquidar(CLAVE, PETICION)).rejects.toThrow(EstadoInesperadoError);
      expect(partes.filas).toHaveLength(0);
      expect(stripe.transfer).not.toHaveBeenCalled();
    });
  });

  describe('el pago', () => {
    it('transfiere a cada beneficiario y ata la transferencia al cargo', async () => {
      await servicio.liquidar(CLAVE, PETICION);

      expect(stripe.transfer).toHaveBeenCalledTimes(2);
      expect(stripe.transfer).toHaveBeenCalledWith(
        expect.objectContaining({ payeeRef: 'acct_chofer', amount: 7400, sourceRef: 'ch_1' }),
      );
      expect(stripe.transfer).toHaveBeenCalledWith(
        expect.objectContaining({ payeeRef: 'acct_valet', amount: 1000, sourceRef: 'ch_1' }),
      );
    });

    it('la clave de la transferencia sale del cobro y del beneficiario', async () => {
      await servicio.liquidar(CLAVE, PETICION);
      expect(stripe.transfer).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: `${CLAVE}_split_driver_${CHOFER}` }),
      );
    });

    // Todo entró en la cuenta de URBONT al cobrar: su parte ya está donde tiene
    // que estar, y ahí se quedan también las comisiones del procesador.
    it('la parte de la plataforma no se transfiere, se marca pagada', async () => {
      const r = await servicio.liquidar(CLAVE, PETICION);
      const plataforma = r.partes.find((p) => p.type === 'platform');
      expect(plataforma?.status).toBe('paid');
      expect(plataforma?.transferRef).toBeNull();
      expect(stripe.transfer).not.toHaveBeenCalledWith(expect.objectContaining({ amount: 3315 }));
    });

    it('si no había cargo guardado, lo relee del procesador', async () => {
      libro.tx = cobroCapturado({ chargeRef: null });
      await servicio.liquidar(CLAVE, PETICION);
      expect(stripe.getAuthorization).toHaveBeenCalledWith('pi_1');
      expect(stripe.transfer).toHaveBeenCalledWith(expect.objectContaining({ sourceRef: 'ch_releido' }));
    });

    it('una parte de cero no genera transferencia', async () => {
      const r = await servicio.liquidar(CLAVE, { ...PETICION, valetCents: 0 });
      expect(r.partes.find((p) => p.type === 'valet')).toBeUndefined();
      expect(stripe.transfer).toHaveBeenCalledTimes(1);
    });
  });

  describe('UN BENEFICIARIO COBRA UNA SOLA VEZ', () => {
    it('repartir dos veces no paga dos veces', async () => {
      await servicio.liquidar(CLAVE, PETICION);
      const segunda = await servicio.liquidar(CLAVE, PETICION);

      expect(stripe.transfer).toHaveBeenCalledTimes(2);
      expect(partes.filas).toHaveLength(3);
      expect(segunda.partes.every((p) => p.status === 'paid')).toBe(true);
    });

    it('un segundo reparto con otros números no cambia lo ya pagado', async () => {
      await servicio.liquidar(CLAVE, PETICION);
      const segunda = await servicio.liquidar(CLAVE, { ...PETICION, commissionRate: 0.5 });

      expect(segunda.partes.find((p) => p.type === 'driver')?.amountCents).toBe(7400);
      expect(stripe.transfer).toHaveBeenCalledTimes(2);
    });
  });

  describe('el modo sombra', () => {
    it('devuelve el cálculo y no mueve un centavo', async () => {
      const r = await servicio.liquidar(CLAVE, { ...PETICION, dryRun: true });

      expect(r.dryRun).toBe(true);
      expect(r.partes.map((p) => [p.type, p.amountCents])).toEqual([
        ['driver', 7400],
        ['valet', 1000],
        ['platform', 3315],
      ]);
      expect(stripe.transfer).not.toHaveBeenCalled();
    });

    // Una fila `pending` que nadie va a pagar es indistinguible, dos semanas
    // después, de una que alguien tiene que pagar. Si la sombra las dejara
    // apuntadas, el día que se quitara el `dryRun` el motor pagaría viajes que
    // urbont-api ya pagó.
    it('NO APUNTA NADA: ni partes, ni asientos', async () => {
      await servicio.liquidar(CLAVE, { ...PETICION, dryRun: true });

      expect(partes.filas).toHaveLength(0);
      expect(contable.asientosPorClave.size).toBe(0);
    });

    it('después de la sombra se puede repartir de verdad, y entonces sí se apunta', async () => {
      await servicio.liquidar(CLAVE, { ...PETICION, dryRun: true });
      const r = await servicio.liquidar(CLAVE, PETICION);

      expect(stripe.transfer).toHaveBeenCalledTimes(2);
      expect(partes.filas).toHaveLength(3);
      expect(r.partes.find((p) => p.type === 'driver')?.status).toBe('paid');
    });
  });

  describe('quien todavía no puede cobrar', () => {
    it('sin cuenta registrada ni en la petición, su parte queda PENDIENTE y no fallida', async () => {
      const r = await servicio.liquidar(CLAVE, {
        ...PETICION,
        beneficiarios: [{ type: 'valet', id: VALET, payeeRef: 'acct_valet' }],
      });

      const chofer = r.partes.find((p) => p.type === 'driver');
      expect(chofer?.status).toBe('pending');
      expect(chofer?.amountCents).toBe(7400);
      // Y al valet se le paga igual: el que falta no bloquea al que está.
      expect(r.partes.find((p) => p.type === 'valet')?.status).toBe('paid');
    });

    it('si la cuenta no está activa, se le pregunta al procesador', async () => {
      stripe.payeeStatus.mockResolvedValueOnce('active');
      const r = await servicio.liquidar(CLAVE, {
        ...PETICION,
        beneficiarios: [{ type: 'driver', id: CHOFER, payeeRef: 'acct_chofer' }],
      });

      expect(stripe.payeeStatus).toHaveBeenCalledWith('acct_chofer');
      expect((await personas.porPersona(CHOFER, 'stripe'))?.status).toBe('active');
      expect(r.partes.find((p) => p.type === 'driver')?.status).toBe('paid');
    });

    it('si el procesador dice que no puede cobrar, queda pendiente', async () => {
      stripe.payeeStatus.mockResolvedValue('restricted');
      const r = await servicio.liquidar(CLAVE, PETICION);

      expect(r.partes.find((p) => p.type === 'driver')?.status).toBe('pending');
      expect(stripe.transfer).not.toHaveBeenCalledWith(expect.objectContaining({ payeeRef: 'acct_chofer' }));
    });

    // Cambiar la cuenta de cobro es una operación explícita, no un efecto
    // colateral de pagar un viaje: si no, una petición bastaría para desviar el
    // dinero de un chofer a otra cuenta.
    it('la cuenta registrada manda sobre la que venga en la petición', async () => {
      await personas.registrarSiFalta({
        payeeId: CHOFER, payeeType: 'driver', provider: 'stripe',
        providerRef: 'acct_el_de_verdad', status: 'active',
      });

      await servicio.liquidar(CLAVE, {
        ...PETICION,
        beneficiarios: [{ type: 'driver', id: CHOFER, payeeRef: 'acct_del_atacante' }],
      });

      expect(stripe.transfer).toHaveBeenCalledWith(
        expect.objectContaining({ payeeRef: 'acct_el_de_verdad', amount: 7400 }),
      );
      expect(stripe.transfer).not.toHaveBeenCalledWith(
        expect.objectContaining({ payeeRef: 'acct_del_atacante' }),
      );
    });
  });

  describe('cuando algo falla', () => {
    it('que falle el pago de uno no deja sin pagar al otro', async () => {
      stripe.transfer.mockRejectedValueOnce(new Error('balance_insufficient'));
      const r = await servicio.liquidar(CLAVE, PETICION);

      expect(r.partes.find((p) => p.type === 'driver')?.status).toBe('failed');
      expect(r.partes.find((p) => p.type === 'driver')?.failureCode).toContain('balance_insufficient');
      expect(r.partes.find((p) => p.type === 'valet')?.status).toBe('paid');
    });

    it('un pago fallido se puede reintentar y entonces sí cobra', async () => {
      stripe.transfer.mockRejectedValueOnce(new Error('se cayó la red'));
      await servicio.liquidar(CLAVE, PETICION);

      const r = await servicio.liquidar(CLAVE, PETICION);
      expect(r.partes.find((p) => p.type === 'driver')?.status).toBe('paid');
    });
  });

  describe('el libro contable', () => {
    it('LOS ASIENTOS DE UN COBRO SUMAN CERO', async () => {
      await servicio.liquidar(CLAVE, PETICION);
      expect(contable.total()).toBe(0);
    });

    it('al repartir nacen las deudas y al pagar se extinguen', async () => {
      // Con el valet sin cuenta activa, su deuda nace y no se extingue: así se
      // ven las dos mitades del asiento en la misma prueba.
      stripe.payeeStatus.mockResolvedValue('restricted');
      await servicio.liquidar(CLAVE, {
        ...PETICION,
        beneficiarios: [{ type: 'valet', id: VALET }],
      });
      let saldos = await contable.saldos();
      expect(saldos.clearing).toBe(11715);
      expect(saldos.driver_payable).toBe(-7400);
      expect(saldos.valet_payable).toBe(-1000);
      expect(saldos.platform_revenue).toBe(-3315);

      stripe.payeeStatus.mockResolvedValue('active');
      await servicio.liquidar(CLAVE, PETICION);
      saldos = await contable.saldos();
      // Pagado el chofer y el valet, en la cuenta queda lo de URBONT.
      expect(saldos.driver_payable).toBe(0);
      expect(saldos.valet_payable).toBe(0);
      expect(saldos.clearing).toBe(3315);
      expect(contable.total()).toBe(0);
    });

    it('repartir dos veces no duplica asientos', async () => {
      await servicio.liquidar(CLAVE, PETICION);
      const cuantos = contable.asientosPorClave.size;
      await servicio.liquidar(CLAVE, PETICION);
      expect(contable.asientosPorClave.size).toBe(cuantos);
      expect(contable.total()).toBe(0);
    });
  });

  describe('las deudas del chofer', () => {
    it('se descuentan de su parte, se quedan en la plataforma y quedan apuntadas', async () => {
      const r = await servicio.liquidar(CLAVE, {
        ...PETICION,
        driverDeductionCents: 2000,
        driverDeductionMemo: 'penalidad por soltar una reserva',
      });

      expect(r.partes.find((p) => p.type === 'driver')?.amountCents).toBe(5400);
      expect(r.partes.find((p) => p.type === 'driver')?.deductionCents).toBe(2000);
      expect(r.partes.find((p) => p.type === 'platform')?.amountCents).toBe(5315);
      expect(partes.filas.find((f) => f.beneficiaryType === 'driver')?.memo).toContain('penalidad');
      expect(contable.total()).toBe(0);
    });
  });
});
