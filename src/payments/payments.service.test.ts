import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  PaymentsService,
  TransaccionNoEncontradaError,
  EstadoInesperadoError,
  type PeticionDeCobro,
} from './payments.service';
import { ProviderRegistry } from '../providers/provider.registry';
import type {
  PaymentProvider,
  ProviderCapabilities,
  ProviderName,
} from '../providers/provider.port';
import type {
  NuevaTransaccion,
  ResultadoDeCreacion,
  Transaction,
  TransactionsRepository,
} from '../ledger/transactions.repository';

/** El libro, en memoria: misma restricción de clave única que la base. */
class LibroEnMemoria implements TransactionsRepository {
  private readonly filas = new Map<string, Transaction>();
  private siguiente = 1;

  async crearSiNoExiste(nueva: NuevaTransaccion): Promise<ResultadoDeCreacion> {
    const existente = [...this.filas.values()].find((t) => t.idempotencyKey === nueva.idempotencyKey);
    if (existente) return { transaccion: existente, yaExistia: true };

    const t: Transaction = {
      id: `tx_${this.siguiente++}`,
      idempotencyKey: nueva.idempotencyKey,
      provider: nueva.provider,
      providerRef: null,
      chargeRef: null,
      kind: nueva.kind,
      rideId: nueva.rideId ?? null,
      payerId: nueva.payerId ?? null,
      amountCents: nueva.amountCents,
      taxCents: nueva.taxCents ?? 0,
      currency: nueva.currency,
      status: 'pending',
      authorizedAt: null,
      capturedAt: null,
      failedAt: null,
      failureCode: null,
      createdAt: new Date(),
    };
    this.filas.set(t.id, t);
    return { transaccion: t, yaExistia: false };
  }

  async porId(id: string) { return this.filas.get(id) ?? null; }
  async porClaveDeIdempotencia(clave: string) {
    return [...this.filas.values()].find((t) => t.idempotencyKey === clave) ?? null;
  }
  async porReferenciaDelProveedor(provider: ProviderName, ref: string) {
    return [...this.filas.values()].find((t) => t.provider === provider && t.providerRef === ref) ?? null;
  }
  async marcarAutorizada(id: string, providerRef: string) {
    return this.set(id, { status: 'authorized', providerRef, authorizedAt: new Date() });
  }
  async marcarCapturada(id: string, providerRef: string, capturado: number, chargeRef?: string | null) {
    return this.set(id, {
      status: 'captured', providerRef, amountCents: capturado, capturedAt: new Date(),
      ...(chargeRef ? { chargeRef } : {}),
    });
  }
  /** La referencia queda, el estado no cambia: el cobro aún no ha ocurrido. */
  async guardarReferencia(id: string, providerRef: string) {
    return this.set(id, { providerRef });
  }
  async marcarFallida(id: string, codigo: string) {
    return this.set(id, { status: 'failed', failureCode: codigo, failedAt: new Date() });
  }
  async marcarAnulada(id: string) { return this.set(id, { status: 'voided' }); }
  async marcarReembolsada(id: string) { return this.set(id, { status: 'refunded' }); }

  private set(id: string, cambios: Partial<Transaction>): Transaction {
    const t = this.filas.get(id);
    if (!t) throw new Error(`no existe ${id}`);
    const nuevo = { ...t, ...cambios };
    this.filas.set(id, nuevo);
    return nuevo;
  }
}

/** Los asientos, con el índice único de `entry_key` imitado. */
class AsientosEnMemoria {
  porClave = new Map<string, { account: string; amountCents: number }>();
  async asentar(as: Array<{ entryKey: string; account: string; amountCents: number }>) {
    let n = 0;
    for (const a of as) {
      if (this.porClave.has(a.entryKey)) continue;
      this.porClave.set(a.entryKey, { account: a.account, amountCents: a.amountCents });
      n++;
    }
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

const capacidades = (extra: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  manualCapture: true,
  partialCapture: true,
  increaseAuthorization: true,
  tapToPay: true,
  savedCards: true,
  payouts: true,
  splitAtCapture: false,
  bankDebit: false,
  currencies: ['USD'],
  ...extra,
});

function proveedorFalso(name: ProviderName) {
  return {
    name,
    capabilities: capacidades(),
    authorize: vi.fn(async () => ({
      providerRef: `${name}_ref_1`, provider: name, status: 'authorized' as const,
      amount: 11000, currency: 'USD' as const, clientSecret: `${name}_ref_1_secret`,
    })),
    getAuthorization: vi.fn(async (ref: string) => ({
      providerRef: ref, provider: name, status: 'authorized' as const,
      amount: 11000, currency: 'USD' as const, clientSecret: `${ref}_secret`,
    })),
    increaseAuthorization: vi.fn(async (cmd: { providerRef: string; amount: number }) => ({
      providerRef: cmd.providerRef, provider: name, status: 'authorized' as const,
      amount: cmd.amount, currency: 'USD' as const,
    })),
    capture: vi.fn(async (cmd: { amount?: number }) => ({
      providerRef: `${name}_ref_1`, provider: name, captured: cmd.amount ?? 11000,
      currency: 'USD' as const,
    })),
    chargeSavedCard: vi.fn(async () => ({
      providerRef: `${name}_ref_1`, provider: name, status: 'captured' as const,
      amount: 11000, currency: 'USD' as const, chargeRef: `${name}_cargo_1`,
    })),
    presentCharge: vi.fn(async () => ({
      providerRef: `${name}_ref_presencial`, provider: name, status: 'requires_action' as const,
      amount: 11000, currency: 'USD' as const, clientSecret: `${name}_presencial_secret`,
    })),
    terminalSession: vi.fn(async () => ({
      provider: name, token: 'pst_1', locationRef: 'tml_1',
    })),
    voidAuthorization: vi.fn(async () => undefined),
    // Devuelve lo que se le pidió, como hace un procesador de verdad: el libro
    // apunta lo que el procesador dice que devolvió, no lo que se le pidió.
    refund: vi.fn(async (cmd: { amount?: number }) => ({
      providerRef: `${name}_ref_1`, provider: name, refunded: cmd.amount ?? 11000, currency: 'USD' as const,
    })),
  } as unknown as PaymentProvider & {
    authorize: ReturnType<typeof vi.fn>;
    chargeSavedCard: ReturnType<typeof vi.fn>;
    presentCharge: ReturnType<typeof vi.fn>;
    terminalSession: ReturnType<typeof vi.fn>;
    getAuthorization: ReturnType<typeof vi.fn>;
    increaseAuthorization: ReturnType<typeof vi.fn>;
    capture: ReturnType<typeof vi.fn>;
    voidAuthorization: ReturnType<typeof vi.fn>;
    refund: ReturnType<typeof vi.fn>;
  };
}

const cobro: PeticionDeCobro = {
  idempotencyKey: 'ride_abc_authorize',
  kind: 'ride',
  amountCents: 11000,
  currency: 'USD',
  hold: true,
  rideId: 'ride-abc',
  payerId: 'pax-1',
};

describe('PaymentsService · autorizar', () => {
  let libro: LibroEnMemoria;
  let stripe: ReturnType<typeof proveedorFalso>;
  let servicio: PaymentsService;
  let asientos: AsientosEnMemoria;

  beforeEach(() => {
    libro = new LibroEnMemoria();
    stripe = proveedorFalso('stripe');
    asientos = new AsientosEnMemoria();
    servicio = new PaymentsService(new ProviderRegistry([stripe], 'stripe'), libro, asientos as never);
  });

  it('apunta la intención en el libro y cobra', async () => {
    const { transaccion } = await servicio.autorizar(cobro);

    expect(stripe.authorize).toHaveBeenCalledOnce();
    expect(transaccion).toMatchObject({
      status: 'authorized', provider: 'stripe', providerRef: 'stripe_ref_1', rideId: 'ride-abc',
    });
  });

  it('UN REINTENTO NO COBRA DOS VECES', async () => {
    const primera = await servicio.autorizar(cobro);
    const segunda = await servicio.autorizar(cobro);

    expect(stripe.authorize).toHaveBeenCalledOnce();
    expect(segunda.transaccion.id).toBe(primera.transaccion.id);
  });

  it('el reintento devuelve el clientSecret, releyendo el cobro sin volver a cobrar', async () => {
    await servicio.autorizar(cobro);
    const segunda = await servicio.autorizar(cobro);

    expect(stripe.authorize).toHaveBeenCalledOnce();
    expect(stripe.getAuthorization).toHaveBeenCalledWith('stripe_ref_1');
    expect(segunda.autorizacion?.clientSecret).toBe('stripe_ref_1_secret');
  });

  it('si releer el cobro falla, el reintento devuelve la fila igual', async () => {
    await servicio.autorizar(cobro);
    stripe.getAuthorization.mockRejectedValueOnce(new Error('Stripe no contesta'));

    const segunda = await servicio.autorizar(cobro);

    expect(segunda.transaccion.providerRef).toBe('stripe_ref_1');
    expect(segunda.autorizacion).toBeNull();
  });

  it('dos viajes distintos sí son dos cobros', async () => {
    await servicio.autorizar(cobro);
    await servicio.autorizar({ ...cobro, idempotencyKey: 'ride_xyz_authorize', rideId: 'ride-xyz' });
    expect(stripe.authorize).toHaveBeenCalledTimes(2);
  });

  it('un cobro sin retención queda capturado de una vez', async () => {
    stripe.authorize.mockResolvedValueOnce({
      providerRef: 'pi_directo', provider: 'stripe', status: 'captured', amount: 2500, currency: 'USD',
    });
    const { transaccion } = await servicio.autorizar({ ...cobro, hold: false, amountCents: 2500 });
    expect(transaccion.status).toBe('captured');
  });

  it('si el procesador falla, queda constancia y el error sube', async () => {
    stripe.authorize.mockRejectedValueOnce(Object.assign(new Error('tarjeta rechazada'), { code: 'card_declined' }));

    await expect(servicio.autorizar(cobro)).rejects.toThrow('tarjeta rechazada');

    const fila = await libro.porClaveDeIdempotencia(cobro.idempotencyKey);
    expect(fila).toMatchObject({ status: 'failed', failureCode: 'card_declined' });
  });

  it('una retención exige un procesador que sepa retener', async () => {
    const sinRetencion = proveedorFalso('paypal');
    (sinRetencion as { capabilities: ProviderCapabilities }).capabilities = capacidades({ manualCapture: false });
    const soloPaypal = new PaymentsService(new ProviderRegistry([sinRetencion], 'paypal'), libro, new AsientosEnMemoria() as never);

    await expect(soloPaypal.autorizar(cobro)).rejects.toThrow(/manualCapture/);
  });
});

describe('PaymentsService · cobrar contra una tarjeta guardada', () => {
  let libro: LibroEnMemoria;
  let stripe: ReturnType<typeof proveedorFalso>;
  let servicio: PaymentsService;
  let asientos: AsientosEnMemoria;

  const propina: PeticionDeCobro = {
    idempotencyKey: 'tip_ride-abc_authorize',
    kind: 'tip',
    amountCents: 1500,
    currency: 'USD',
    hold: false,
    rideId: 'ride-abc',
    payerId: 'pax-1',
    customerRef: 'cus_1',
    cardRef: 'pm_1',
    description: 'URBONT tip',
  };

  beforeEach(() => {
    libro = new LibroEnMemoria();
    stripe = proveedorFalso('stripe');
    asientos = new AsientosEnMemoria();
    servicio = new PaymentsService(new ProviderRegistry([stripe], 'stripe'), libro, asientos as never);
  });

  it('va por el camino de la tarjeta guardada, no por el del cobro interactivo', async () => {
    const { transaccion } = await servicio.autorizar(propina);

    expect(stripe.chargeSavedCard).toHaveBeenCalledWith(
      expect.objectContaining({ cardRef: 'pm_1', customerRef: 'cus_1', description: 'URBONT tip' }),
    );
    expect(stripe.authorize).not.toHaveBeenCalled();
    expect(transaccion.status).toBe('captured');
  });

  // El fallo que mostró a un chofer una propina de $10 que nadie pagó: crear el
  // cobro no es cobrarlo, y el banco puede pedir autenticación sin que nadie
  // lance un error.
  it('UN COBRO QUE PIDE AUTENTICACIÓN NO SE DA POR COBRADO', async () => {
    stripe.chargeSavedCard.mockResolvedValueOnce({
      providerRef: 'pi_3ds', provider: 'stripe', status: 'requires_action',
      amount: 1500, currency: 'USD', clientSecret: 'pi_3ds_secret',
    });

    const { transaccion, autorizacion } = await servicio.autorizar(propina);

    expect(transaccion.status).toBe('pending');
    // Pero la referencia queda: si no, el cobro sería invisible para nosotros.
    expect(transaccion.providerRef).toBe('pi_3ds');
    expect(autorizacion?.clientSecret).toBe('pi_3ds_secret');
  });

  it('un cobro que el procesador deja en fallido queda fallido', async () => {
    stripe.chargeSavedCard.mockResolvedValueOnce({
      providerRef: 'pi_no', provider: 'stripe', status: 'failed',
      amount: 1500, currency: 'USD',
    });

    const { transaccion } = await servicio.autorizar(propina);

    expect(transaccion.status).toBe('failed');
    expect(transaccion.failureCode).toBe('provider_status_failed');
  });

  it('un reintento no vuelve a cobrar la propina', async () => {
    await servicio.autorizar(propina);
    await servicio.autorizar(propina);
    expect(stripe.chargeSavedCard).toHaveBeenCalledOnce();
  });

  it('sin procesador que sepa cobrar tarjetas guardadas, no se cobra', async () => {
    const corto = proveedorFalso('paypal');
    (corto as unknown as { capabilities: ProviderCapabilities }).capabilities =
      capacidades({ savedCards: false });
    const servicio2 = new PaymentsService(new ProviderRegistry([corto], 'paypal'), libro, new AsientosEnMemoria() as never);

    await expect(servicio2.autorizar(propina)).rejects.toThrow(/savedCards/);
  });

  it('guarda el cargo, que es lo que financia el pago al chofer', async () => {
    const { transaccion } = await servicio.autorizar(propina);
    expect(transaccion.chargeRef).toBe('stripe_cargo_1');
  });
});

describe('PaymentsService · cobrar en persona', () => {
  let libro: LibroEnMemoria;
  let stripe: ReturnType<typeof proveedorFalso>;
  let servicio: PaymentsService;

  const presencial = {
    idempotencyKey: 'tap_to_pay_ride-abc_intento1',
    kind: 'ride' as const,
    amountCents: 11715,
    currency: 'USD' as const,
    hold: false,
    rideId: 'ride-abc',
    payerId: 'drv-1',
    taxCents: 715,
  };

  beforeEach(() => {
    libro = new LibroEnMemoria();
    stripe = proveedorFalso('stripe');
    servicio = new PaymentsService(
      new ProviderRegistry([stripe], 'stripe'), libro, new AsientosEnMemoria() as never,
    );
  });

  // Hoy un cobro presencial se crea en Stripe y de él sólo se entera el
  // webhook: no está en ningún libro, así que no se puede conciliar.
  it('EL COBRO PRESENCIAL QUEDA EN EL LIBRO', async () => {
    const { transaccion } = await servicio.cobrarEnPersona(presencial);

    expect(stripe.presentCharge).toHaveBeenCalledOnce();
    expect(transaccion.idempotencyKey).toBe(presencial.idempotencyKey);
    expect(transaccion.providerRef).toBe('stripe_ref_presencial');
  });

  // Lo remata el SDK del teléfono. Hasta entonces no ha pasado nada, y dar por
  // cobrado lo que no se ha cobrado es el fallo que ya le mostró a un chofer
  // una propina que nadie pagó.
  it('mientras el teléfono no lo remate, el cobro NO está hecho', async () => {
    const { transaccion, autorizacion } = await servicio.cobrarEnPersona(presencial);

    expect(transaccion.status).toBe('pending');
    expect(autorizacion?.clientSecret).toBe('stripe_presencial_secret');
  });

  it('va por el camino presencial, no por el del cobro con tarjeta', async () => {
    await servicio.cobrarEnPersona(presencial);
    expect(stripe.authorize).not.toHaveBeenCalled();
    expect(stripe.chargeSavedCard).not.toHaveBeenCalled();
  });

  it('el chofer que le da dos veces al botón no crea dos cobros', async () => {
    await servicio.cobrarEnPersona(presencial);
    await servicio.cobrarEnPersona(presencial);
    expect(stripe.presentCharge).toHaveBeenCalledOnce();
  });

  it('sin un procesador que sepa cobrar en persona, no se cobra', async () => {
    const corto = proveedorFalso('paypal');
    (corto as unknown as { capabilities: ProviderCapabilities }).capabilities =
      capacidades({ tapToPay: false });
    const servicio2 = new PaymentsService(
      new ProviderRegistry([corto], 'paypal'), libro, new AsientosEnMemoria() as never,
    );

    await expect(servicio2.cobrarEnPersona(presencial)).rejects.toThrow(/tapToPay/);
  });

  it('el token del lector viene del procesador que cobra', async () => {
    const sesion = await servicio.sesionDeTerminal();
    expect(sesion).toMatchObject({ provider: 'stripe', token: 'pst_1', locationRef: 'tml_1' });
  });
});

describe('PaymentsService · capturar', () => {
  let libro: LibroEnMemoria;
  let stripe: ReturnType<typeof proveedorFalso>;
  let servicio: PaymentsService;
  let asientos: AsientosEnMemoria;

  beforeEach(async () => {
    libro = new LibroEnMemoria();
    stripe = proveedorFalso('stripe');
    asientos = new AsientosEnMemoria();
    servicio = new PaymentsService(new ProviderRegistry([stripe], 'stripe'), libro, asientos as never);
    await servicio.autorizar(cobro);
  });

  it('cobra lo retenido', async () => {
    const tx = await servicio.capturar(cobro.idempotencyKey);
    expect(tx.status).toBe('captured');
    expect(tx.amountCents).toBe(11000);
  });

  it('captura parcial: se queda con lo que de verdad entró', async () => {
    stripe.capture.mockResolvedValueOnce({
      providerRef: 'stripe_ref_1', provider: 'stripe', captured: 5500, currency: 'USD',
    });
    const tx = await servicio.capturar(cobro.idempotencyKey, 5500);
    expect(tx.amountCents).toBe(5500);
  });

  it('capturar dos veces no cobra dos veces', async () => {
    await servicio.capturar(cobro.idempotencyKey);
    await servicio.capturar(cobro.idempotencyKey);
    expect(stripe.capture).toHaveBeenCalledOnce();
  });

  it('no captura algo que no existe', async () => {
    await expect(servicio.capturar('no_existe')).rejects.toThrow(TransaccionNoEncontradaError);
  });

  it('no captura un cobro ya anulado', async () => {
    await servicio.anular(cobro.idempotencyKey);
    await expect(servicio.capturar(cobro.idempotencyKey)).rejects.toThrow(EstadoInesperadoError);
  });

  // El caso del cargo por espera: el viaje se autoriza al reservar por $110 y al
  // terminar hay que cobrar $120. Capturar sin subir primero la autorización le
  // regalaría la espera al pasajero, porque Stripe no captura más de lo autorizado.
  it('sube la autorización antes de capturar un importe mayor', async () => {
    const tx = await servicio.capturar(cobro.idempotencyKey, 12000);

    expect(stripe.increaseAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: 'stripe_ref_1', amount: 12000 }),
    );
    expect(stripe.capture).toHaveBeenCalledWith(expect.objectContaining({ amount: 12000 }));
    expect(tx.amountCents).toBe(12000);
  });

  it('la clave de subir lleva el importe, para que dos subidas no se pisen', async () => {
    await servicio.capturar(cobro.idempotencyKey, 12000);
    expect(stripe.increaseAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'ride_abc_authorize_increase_12000' }),
    );
  });

  it('no toca la autorización si el importe cabe en lo autorizado', async () => {
    await servicio.capturar(cobro.idempotencyKey, 9000);
    expect(stripe.increaseAuthorization).not.toHaveBeenCalled();
    expect(stripe.capture).toHaveBeenCalledWith(expect.objectContaining({ amount: 9000 }));
  });

  it('si el procesador no sabe subir, captura lo autorizado y no revienta', async () => {
    const corto = proveedorFalso('square');
    (corto as unknown as { capabilities: ProviderCapabilities }).capabilities =
      capacidades({ increaseAuthorization: false });
    const servicio2 = new PaymentsService(new ProviderRegistry([corto], 'square'), libro, new AsientosEnMemoria() as never);
    await servicio2.autorizar({ ...cobro, idempotencyKey: 'ride_sq_authorize' });

    const tx = await servicio2.capturar('ride_sq_authorize', 12000);

    expect(corto.increaseAuthorization).not.toHaveBeenCalled();
    expect(corto.capture).toHaveBeenCalledWith(expect.objectContaining({ amount: 11000 }));
    expect(tx.amountCents).toBe(11000);
  });

  it('si el banco rechaza la subida, se captura lo autorizado', async () => {
    stripe.increaseAuthorization.mockRejectedValueOnce(new Error('el emisor no autoriza más'));

    const tx = await servicio.capturar(cobro.idempotencyKey, 12000);

    expect(stripe.capture).toHaveBeenCalledWith(expect.objectContaining({ amount: 11000 }));
    expect(tx.amountCents).toBe(11000);
  });
});

describe('PaymentsService · la regla del procesador originario', () => {
  it('reembolsa por donde se cobró, aunque hoy el por defecto sea otro', async () => {
    const libro = new LibroEnMemoria();
    const stripe = proveedorFalso('stripe');
    const adyen = proveedorFalso('adyen');

    // El cobro se hizo cuando Stripe era el procesador por defecto.
    const conStripe = new PaymentsService(new ProviderRegistry([stripe, adyen], 'stripe'), libro, new AsientosEnMemoria() as never);
    await conStripe.autorizar(cobro);
    await conStripe.capturar(cobro.idempotencyKey);

    // Meses después, el por defecto es Adyen y hay que devolver el dinero.
    const conAdyen = new PaymentsService(new ProviderRegistry([stripe, adyen], 'adyen'), libro, new AsientosEnMemoria() as never);
    const { reembolso } = await conAdyen.reembolsar(cobro.idempotencyKey);

    expect(stripe.refund).toHaveBeenCalledOnce();
    expect(adyen.refund).not.toHaveBeenCalled();
    expect(reembolso.provider).toBe('stripe');
  });

  it('un cobro nuevo sí va al procesador de hoy', async () => {
    const libro = new LibroEnMemoria();
    const stripe = proveedorFalso('stripe');
    const adyen = proveedorFalso('adyen');
    const servicio = new PaymentsService(new ProviderRegistry([stripe, adyen], 'adyen'), libro, new AsientosEnMemoria() as never);

    await servicio.autorizar(cobro);

    expect(adyen.authorize).toHaveBeenCalledOnce();
    expect(stripe.authorize).not.toHaveBeenCalled();
  });

  it('si el procesador de aquel cobro ya no está montado, se dice claro', async () => {
    const libro = new LibroEnMemoria();
    const stripe = proveedorFalso('stripe');
    const conStripe = new PaymentsService(new ProviderRegistry([stripe], 'stripe'), libro, new AsientosEnMemoria() as never);
    await conStripe.autorizar(cobro);
    await conStripe.capturar(cobro.idempotencyKey);

    const sinStripe = new PaymentsService(new ProviderRegistry([proveedorFalso('adyen')], 'adyen'), libro);
    await expect(sinStripe.reembolsar(cobro.idempotencyKey)).rejects.toThrow(/stripe/);
  });
});

describe('PaymentsService · reembolsar', () => {
  let libro: LibroEnMemoria;
  let stripe: ReturnType<typeof proveedorFalso>;
  let servicio: PaymentsService;
  let asientos: AsientosEnMemoria;

  beforeEach(async () => {
    libro = new LibroEnMemoria();
    stripe = proveedorFalso('stripe');
    asientos = new AsientosEnMemoria();
    servicio = new PaymentsService(new ProviderRegistry([stripe], 'stripe'), libro, asientos as never);
    await servicio.autorizar(cobro);
  });

  it('no se devuelve lo que todavía no se ha cobrado', async () => {
    await expect(servicio.reembolsar(cobro.idempotencyKey)).rejects.toThrow(EstadoInesperadoError);
  });

  it('un reembolso total deja la transacción como reembolsada', async () => {
    await servicio.capturar(cobro.idempotencyKey);
    const { transaccion } = await servicio.reembolsar(cobro.idempotencyKey);
    expect(transaccion.status).toBe('refunded');
  });

  // Si el libro no se enterara hasta el webhook, una instalación sin webhooks
  // configurados devolvería dinero sin que quedara rastro.
  it('el libro se entera aquí mismo, sin esperar al aviso del procesador', async () => {
    await servicio.capturar(cobro.idempotencyKey);
    await servicio.reembolsar(cobro.idempotencyKey, { amountCents: 5500 });

    const saldos = await asientos.saldos();
    expect(saldos.clearing).toBe(-5500);
    expect(saldos.platform_revenue).toBe(5500);
    expect(asientos.total()).toBe(0);
  });

  it('y la clave del asiento sale de la referencia del reembolso', async () => {
    await servicio.capturar(cobro.idempotencyKey);
    await servicio.reembolsar(cobro.idempotencyKey, { amountCents: 5500 });
    expect([...asientos.porClave.keys()].some((k) => k.includes(':refund:stripe_ref_1:'))).toBe(true);
  });

  it('un reembolso parcial deja el cobro como capturado', async () => {
    await servicio.capturar(cobro.idempotencyKey);
    stripe.refund.mockResolvedValueOnce({
      providerRef: 'stripe_ref_1', provider: 'stripe', refunded: 3000, currency: 'USD',
    });
    const { transaccion } = await servicio.reembolsar(cobro.idempotencyKey, { amountCents: 3000 });
    expect(transaccion.status).toBe('captured');
  });
});
