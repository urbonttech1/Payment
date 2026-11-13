import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderRegistry } from '../providers/provider.registry';
import type {
  PaymentProvider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderName,
} from '../providers/provider.port';
import type { Transaction, TransactionsRepository } from '../ledger/transactions.repository';
import type { EntriesRepository, NuevoAsiento } from '../ledger/entries.repository';
import type { NuevoPayee, Payee, PayeesRepository } from '../payees/payees.repository';
import type { AvisoGuardado, WebhookEventsRepository } from './webhook-events.repository';
import { WebhooksService } from './webhooks.service';
import { UrbontApiNoContestaError } from './urbont-api.client';

const CLAVE = 'ride_abc_authorize';
const PI = 'pi_1';
const CUENTA = 'acct_chofer';
const CHOFER = '11111111-1111-4111-8111-111111111111';

// ── Dobles ──────────────────────────────────────────────────────────────────

class AvisosEnMemoria implements WebhookEventsRepository {
  filas: AvisoGuardado[] = [];
  private n = 0;

  async guardarSiEsNuevo(e: ProviderEvent) {
    // La restricción UNIQUE (provider, event_id) de la base, imitada.
    const existente = this.filas.find((f) => f.provider === e.provider && f.eventId === e.eventId);
    if (existente) return { aviso: existente, yaExistia: true };
    const aviso: AvisoGuardado = {
      id: `aviso-${++this.n}`,
      provider: e.provider,
      eventId: e.eventId,
      eventType: e.type,
      providerRef: e.providerRef,
      status: 'received',
      attempts: 0,
      lastError: null,
      payload: e.raw,
      occurredAt: e.occurredAt,
      createdAt: new Date(),
    };
    this.filas.push(aviso);
    return { aviso, yaExistia: false };
  }

  async porId(id: string) { return this.filas.find((f) => f.id === id) ?? null; }
  async pendientes(limite: number) {
    return this.filas.filter((f) => f.status === 'received' || f.status === 'failed').slice(0, limite);
  }
  async marcarProcesado(id: string) { return this.set(id, { status: 'processed' }); }
  async marcarIgnorado(id: string, motivo: string) { return this.set(id, { status: 'ignored', lastError: motivo }); }
  async marcarFallido(id: string, error: string) { return this.set(id, { status: 'failed', lastError: error }); }

  private set(id: string, cambios: Partial<AvisoGuardado>) {
    const i = this.filas.findIndex((f) => f.id === id);
    if (i < 0) throw new Error(`no existe ${id}`);
    this.filas[i] = { ...this.filas[i], ...cambios, attempts: this.filas[i].attempts + 1 };
    return this.filas[i];
  }
}

function cobro(cambios: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1', idempotencyKey: CLAVE, provider: 'stripe', providerRef: PI, chargeRef: 'ch_1',
    kind: 'ride', rideId: 'b0a1c2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d', payerId: null,
    amountCents: 11715, taxCents: 715, currency: 'USD', status: 'captured',
    authorizedAt: new Date(), capturedAt: new Date(), failedAt: null, failureCode: null,
    createdAt: new Date(), ...cambios,
  };
}

function libroFalso(tx: Transaction | null) {
  return {
    tx,
    porReferenciaDelProveedor: vi.fn(async () => tx),
    marcarAutorizada: vi.fn(async () => cobro({ status: 'authorized' })),
    marcarCapturada: vi.fn(async () => cobro({ status: 'captured' })),
    marcarFallida: vi.fn(async () => cobro({ status: 'failed' })),
    marcarReembolsada: vi.fn(async () => cobro({ status: 'refunded' })),
    crearSiNoExiste: vi.fn(),
    porId: vi.fn(),
    porClaveDeIdempotencia: vi.fn(),
    guardarReferencia: vi.fn(),
    marcarAnulada: vi.fn(),
    capturadasEntre: vi.fn(async () => []),
  } as unknown as TransactionsRepository & Record<string, ReturnType<typeof vi.fn>>;
}

class BeneficiariosEnMemoria implements PayeesRepository {
  filas: Payee[] = [{
    id: 'p1', payeeId: CHOFER, payeeType: 'driver', provider: 'stripe',
    providerRef: CUENTA, status: 'pending', country: 'US', checkedAt: null,
  }];
  async registrarSiFalta(n: NuevoPayee) {
    return { payee: this.filas[0], yaExistia: true, ...(n ? {} : {}) };
  }
  async porPersona(payeeId: string, provider: ProviderName) {
    return this.filas.find((f) => f.payeeId === payeeId && f.provider === provider) ?? null;
  }
  async porReferencia(provider: ProviderName, providerRef: string) {
    return this.filas.find((f) => f.provider === provider && f.providerRef === providerRef) ?? null;
  }
  async actualizarCuenta() { return this.filas[0]; }
  async actualizarEstado(payeeId: string, provider: ProviderName, status: Payee['status']) {
    this.filas[0] = { ...this.filas[0], status };
    return this.filas[0];
  }
}

class AsientosEnMemoria implements EntriesRepository {
  porClave = new Map<string, NuevoAsiento>();
  async asentar(as: NuevoAsiento[]) {
    let n = 0;
    for (const a of as) { if (!this.porClave.has(a.entryKey)) { this.porClave.set(a.entryKey, a); n++; } }
    return n;
  }
  async porTransaccion() { return []; }
  async saldos() {
    const s: Record<string, number> = {};
    for (const a of this.porClave.values()) s[a.account] = (s[a.account] ?? 0) + a.amountCents;
    return s;
  }
  total() { return [...this.porClave.values()].reduce((t, a) => t + a.amountCents, 0); }
}

const capacidades = (): ProviderCapabilities => ({
  manualCapture: true, partialCapture: true, increaseAuthorization: true, savedCards: true,
  payouts: true, splitAtCapture: false, tapToPay: false, bankDebit: false, currencies: ['USD'],
});

function proveedorFalso(eventos: ProviderEvent[]) {
  return {
    name: 'stripe' as ProviderName,
    capabilities: capacidades(),
    parseWebhook: vi.fn(async () => eventos),
    payeeStatus: vi.fn(async () => 'active' as const),
    listCharges: vi.fn(async () => []),
  } as unknown as PaymentProvider & {
    parseWebhook: ReturnType<typeof vi.fn>;
    payeeStatus: ReturnType<typeof vi.fn>;
  };
}

const evento = (cambios: Partial<ProviderEvent> = {}): ProviderEvent => ({
  eventId: 'evt_1',
  provider: 'stripe',
  type: 'payment.captured',
  providerRef: PI,
  amount: 11715,
  currency: 'USD',
  occurredAt: new Date('2026-11-09T10:00:00Z'),
  raw: { id: 'evt_1' },
  ...cambios,
});

function montar(eventos: ProviderEvent[], tx: Transaction | null = cobro()) {
  const avisos = new AvisosEnMemoria();
  const libro = libroFalso(tx);
  const personas = new BeneficiariosEnMemoria();
  const asientos = new AsientosEnMemoria();
  const stripe = proveedorFalso(eventos);
  const urbont = { configurado: true, avisar: vi.fn(async () => {}) };
  const servicio = new WebhooksService(
    new ProviderRegistry([stripe], 'stripe'),
    avisos, libro, personas, asientos,
    urbont as unknown as import('./urbont-api.client').UrbontApiClient,
  );
  return { servicio, avisos, libro, personas, asientos, stripe, urbont };
}

const PETICION = { raw: Buffer.from('{}'), headers: { 'stripe-signature': 't=1,v1=abc' } };

// ── Pruebas ─────────────────────────────────────────────────────────────────

describe('un aviso llega una sola vez', () => {
  // Stripe reenvía el mismo evento durante tres días hasta recibir un 2xx, y
  // manda varios a la vez. Sin esto, el dinero se movería en cada reenvío.
  it('EL MISMO EVENTO DOS VECES SE PROCESA UNA', async () => {
    const { servicio, libro } = montar([evento()], cobro({ status: 'authorized' }));

    const primera = await servicio.recibir('stripe', PETICION);
    const segunda = await servicio.recibir('stripe', PETICION);

    expect(primera).toMatchObject({ nuevos: 1, repetidos: 0, procesados: 1 });
    expect(segunda).toMatchObject({ nuevos: 0, repetidos: 1, procesados: 0 });
    expect(libro.marcarCapturada).toHaveBeenCalledOnce();
  });

  it('el aviso se guarda ANTES de actuar', async () => {
    const { servicio, avisos } = montar([evento()], cobro({ status: 'authorized' }));
    await servicio.recibir('stripe', PETICION);

    expect(avisos.filas).toHaveLength(1);
    expect(avisos.filas[0].payload).toEqual({ id: 'evt_1' });
    expect(avisos.filas[0].status).toBe('processed');
  });

  it('una firma que no cuadra no guarda nada y lanza', async () => {
    const { servicio, avisos, stripe } = montar([evento()]);
    stripe.parseWebhook.mockRejectedValueOnce(new Error('firma inválida'));

    await expect(servicio.recibir('stripe', PETICION)).rejects.toThrow('firma inválida');
    expect(avisos.filas).toHaveLength(0);
  });
});

describe('qué hace cada aviso', () => {
  it('payment.captured captura el cobro que estaba retenido', async () => {
    const { servicio, libro } = montar([evento()], cobro({ status: 'authorized' }));
    await servicio.recibir('stripe', PETICION);
    expect(libro.marcarCapturada).toHaveBeenCalledWith('tx-1', PI, 11715);
  });

  // Square avisa de un pago hecho por el teléfono con su cargo: si el aviso lo
  // trae, se apunta junto con la captura; si no lo trae (Stripe), no se toca.
  it('si el aviso trae el cargo, se apunta al capturar', async () => {
    const { servicio, libro } = montar([evento({ chargeRef: 'sqpmt_1' })], cobro({ status: 'pending' }));
    await servicio.recibir('stripe', PETICION);
    expect(libro.marcarCapturada).toHaveBeenCalledWith('tx-1', PI, 11715, 'sqpmt_1');
  });

  it('un cobro ya capturado no se vuelve a capturar', async () => {
    const { servicio, libro } = montar([evento()], cobro({ status: 'captured' }));
    await servicio.recibir('stripe', PETICION);
    expect(libro.marcarCapturada).not.toHaveBeenCalled();
  });

  it('payment.failed marca el cobro fallido', async () => {
    const { servicio, libro } = montar([evento({ type: 'payment.failed' })], cobro({ status: 'pending' }));
    await servicio.recibir('stripe', PETICION);
    expect(libro.marcarFallida).toHaveBeenCalled();
  });

  // Un aviso de fallo que llega tarde no puede desdecir un cobro que ya entró.
  it('un payment.failed NO desmarca un cobro ya capturado', async () => {
    const { servicio, libro } = montar([evento({ type: 'payment.failed' })], cobro({ status: 'captured' }));
    await servicio.recibir('stripe', PETICION);
    expect(libro.marcarFallida).not.toHaveBeenCalled();
  });

  it('payee.updated le pregunta al procesador y actualiza la cuenta', async () => {
    const { servicio, personas, stripe } = montar([
      evento({ type: 'payee.updated', providerRef: CUENTA, eventId: 'evt_acct' }),
    ]);

    await servicio.recibir('stripe', PETICION);

    expect(stripe.payeeStatus).toHaveBeenCalledWith(CUENTA);
    expect(personas.filas[0].status).toBe('active');
  });

  it('un payout del procesador a su banco se ignora, no falla', async () => {
    const { servicio, avisos } = montar([evento({ type: 'payout.paid', eventId: 'evt_po' })]);
    const r = await servicio.recibir('stripe', PETICION);

    expect(r.ignorados).toBe(1);
    expect(avisos.filas[0].status).toBe('ignored');
  });
});

describe('la convivencia con el camino viejo', () => {
  // A este endpoint llegan TODOS los eventos de la cuenta, incluidos los de los
  // cobros que creó urbont-api por su cuenta. Tratarlos como fallo llenaría la
  // cola de reintentos de trabajo imposible.
  it('UN COBRO QUE NO ES NUESTRO SE IGNORA, NO FALLA', async () => {
    const { servicio, avisos } = montar([evento()], null);

    const r = await servicio.recibir('stripe', PETICION);

    expect(r).toMatchObject({ ignorados: 1, fallidos: 0 });
    expect(avisos.filas[0].status).toBe('ignored');
    expect(avisos.filas[0].lastError).toContain('no está en nuestro libro');
  });

  it('y no se le avisa a urbont-api de un cobro ajeno', async () => {
    const { servicio, urbont } = montar([evento()], null);
    await servicio.recibir('stripe', PETICION);
    expect(urbont.avisar).not.toHaveBeenCalled();
  });
});

describe('el reembolso en el libro', () => {
  const reembolso = evento({ type: 'refund.succeeded', eventId: 'evt_re', amount: 11715 });

  it('sale del saldo y reduce el ingreso de la plataforma, y los asientos suman cero', async () => {
    const { servicio, asientos } = montar([reembolso]);
    await servicio.recibir('stripe', PETICION);

    const saldos = await asientos.saldos();
    expect(saldos.clearing).toBe(-11715);
    expect(saldos.platform_revenue).toBe(11715);
    expect(asientos.total()).toBe(0);
  });

  it('un reembolso completo marca el cobro reembolsado', async () => {
    const { servicio, libro } = montar([reembolso]);
    await servicio.recibir('stripe', PETICION);
    expect(libro.marcarReembolsada).toHaveBeenCalled();
  });

  // Capturado sigue estando: devolver una parte no deshace el cobro.
  it('un reembolso PARCIAL no marca el cobro reembolsado', async () => {
    const { servicio, libro, asientos } = montar([{ ...reembolso, amount: 500 }]);
    await servicio.recibir('stripe', PETICION);

    expect(libro.marcarReembolsada).not.toHaveBeenCalled();
    expect((await asientos.saldos()).clearing).toBe(-500);
  });

  // Stripe manda `charge.refunded` Y `refund.created` del mismo reembolso.
  it('dos avisos del mismo reembolso no lo apuntan dos veces', async () => {
    const { servicio, asientos } = montar([reembolso]);
    await servicio.recibir('stripe', PETICION);
    await servicio.recibir('stripe', PETICION);

    expect((await asientos.saldos()).clearing).toBe(-11715);
    expect(asientos.porClave.size).toBe(2);
  });
});

describe('cuando el proceso falla', () => {
  it('el aviso queda fallido y se puede reintentar', async () => {
    const { servicio, avisos, urbont, libro } = montar([evento()], cobro({ status: 'authorized' }));
    urbont.avisar.mockRejectedValueOnce(new UrbontApiNoContestaError('no contesta'));

    const r = await servicio.recibir('stripe', PETICION);
    expect(r.fallidos).toBe(1);
    expect(avisos.filas[0].status).toBe('failed');

    // El reintento no depende de que Stripe insista: Stripe se rinde a los
    // tres días.
    const reintento = await servicio.reintentarPendientes();
    expect(reintento.procesados).toBe(1);
    expect(avisos.filas[0].status).toBe('processed');
    // Y repetir el efecto es inofensivo: el cobro ya estaba capturado.
    expect(libro.marcarCapturada).toHaveBeenCalled();
  });

  it('recibir NO lanza si el proceso falla: el aviso ya es nuestro', async () => {
    const { servicio, urbont } = montar([evento()], cobro({ status: 'authorized' }));
    urbont.avisar.mockRejectedValue(new UrbontApiNoContestaError('no contesta'));

    await expect(servicio.recibir('stripe', PETICION)).resolves.toMatchObject({ fallidos: 1 });
  });

  it('no hay nada que reintentar cuando todo salió bien', async () => {
    const { servicio } = montar([evento()], cobro({ status: 'authorized' }));
    await servicio.recibir('stripe', PETICION);
    expect(await servicio.reintentarPendientes()).toMatchObject({ recibidos: 0 });
  });
});

describe('el aviso a urbont-api', () => {
  it('va con el vocabulario de URBONT, no con el de Stripe', async () => {
    const { servicio, urbont } = montar([evento()], cobro({ status: 'authorized' }));
    await servicio.recibir('stripe', PETICION);

    expect(urbont.avisar).toHaveBeenCalledWith(expect.objectContaining({
      type: 'payment.captured',
      chargeKey: CLAVE,
      rideId: 'b0a1c2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      kind: 'ride',
      amountCents: 11715,
    }));
  });

  it('un aviso que no le concierne no se le manda', async () => {
    const { servicio, urbont } = montar([evento({ type: 'payment.authorized' })], cobro({ status: 'pending' }));
    await servicio.recibir('stripe', PETICION);
    expect(urbont.avisar).not.toHaveBeenCalled();
  });

  it('una disputa sí se le manda, para que alguien la pelee', async () => {
    const { servicio, urbont } = montar([evento({ type: 'chargeback.opened', eventId: 'evt_dp' })]);
    await servicio.recibir('stripe', PETICION);
    expect(urbont.avisar).toHaveBeenCalledWith(expect.objectContaining({ type: 'chargeback.opened' }));
  });
});
