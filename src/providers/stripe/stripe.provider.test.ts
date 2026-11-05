import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';
import { StripeProvider, FirmaInvalidaError } from './stripe.provider';
import type { AuthorizeCommand } from '../provider.port';

/** Un Stripe de mentira: devuelve lo que se le diga y apunta cómo lo llamaron. */
function stripeFalso(respuestas: Record<string, unknown> = {}) {
  const llamadas: Record<string, { args: unknown[] }> = {};
  const registra = (nombre: string, devuelve: unknown) =>
    vi.fn((...args: unknown[]) => {
      llamadas[nombre] = { args };
      return Promise.resolve(devuelve);
    });

  const stripe = {
    paymentIntents: {
      create: registra('paymentIntents.create', respuestas['paymentIntents.create'] ?? {
        id: 'pi_1', status: 'requires_capture', amount: 11000, currency: 'usd', client_secret: 'pi_1_secret',
      }),
      capture: registra('paymentIntents.capture', respuestas['paymentIntents.capture'] ?? {
        id: 'pi_1', status: 'succeeded', amount: 11000, amount_received: 11000, currency: 'usd', latest_charge: 'ch_1',
      }),
      cancel: registra('paymentIntents.cancel', { id: 'pi_1', status: 'canceled' }),
    },
    refunds: {
      create: registra('refunds.create', { id: 're_1', amount: 5000, currency: 'usd' }),
    },
    transfers: {
      create: registra('transfers.create', { id: 'tr_1', amount: 9000, currency: 'usd' }),
    },
    accounts: {
      retrieve: registra('accounts.retrieve', respuestas['accounts.retrieve'] ?? {
        id: 'acct_1', capabilities: { transfers: 'active' },
      }),
    },
    webhooks: { constructEvent: vi.fn() },
  };

  return { stripe: stripe as unknown as Stripe, llamadas, bruto: stripe };
}

const cobroDeViaje: AuthorizeCommand = {
  idempotencyKey: 'ride_abc_authorize',
  kind: 'ride',
  amount: 11000,
  currency: 'USD',
  hold: true,
  taxAmount: 715,
  reference: { rideId: 'ride-abc', payerId: 'pax-1' },
};

describe('StripeProvider · cobrar', () => {
  let falso: ReturnType<typeof stripeFalso>;
  let provider: StripeProvider;

  beforeEach(() => {
    falso = stripeFalso();
    provider = new StripeProvider(falso.stripe, ['whsec_test']);
  });

  it('un cobro con retención se crea con captura manual', async () => {
    const auth = await provider.authorize(cobroDeViaje);
    const [params] = falso.llamadas['paymentIntents.create'].args as [Stripe.PaymentIntentCreateParams];

    expect(params.capture_method).toBe('manual');
    expect(params.amount).toBe(11000);
    expect(auth).toMatchObject({ providerRef: 'pi_1', provider: 'stripe', status: 'authorized' });
  });

  it('NUNCA manda el reparto dentro del cobro', async () => {
    await provider.authorize(cobroDeViaje);
    const [params] = falso.llamadas['paymentIntents.create'].args as [Stripe.PaymentIntentCreateParams];

    // Es la causa del doble pago que la auditoría encontró en urbont-api.
    expect(params.transfer_data).toBeUndefined();
    expect(params.application_fee_amount).toBeUndefined();
    expect(params.on_behalf_of).toBeUndefined();
  });

  it('pasa la clave de idempotencia que le dieron, sin inventarse ninguna', async () => {
    await provider.authorize(cobroDeViaje);
    const [, opciones] = falso.llamadas['paymentIntents.create'].args as [unknown, Stripe.RequestOptions];
    expect(opciones.idempotencyKey).toBe('ride_abc_authorize');
  });

  it('deja en la metadata lo que hace falta para auditar', async () => {
    await provider.authorize(cobroDeViaje);
    const [params] = falso.llamadas['paymentIntents.create'].args as [Stripe.PaymentIntentCreateParams];
    expect(params.metadata).toMatchObject({
      kind: 'ride', ride_id: 'ride-abc', payer_id: 'pax-1', tax_amount_cents: '715',
    });
  });

  it('un cobro sin retención se cobra en el acto', async () => {
    await provider.authorize({ ...cobroDeViaje, hold: false });
    const [params] = falso.llamadas['paymentIntents.create'].args as [Stripe.PaymentIntentCreateParams];
    expect(params.capture_method).toBe('automatic');
  });
});

describe('StripeProvider · capturar y devolver', () => {
  it('captura lo autorizado y devuelve lo que de verdad entró', async () => {
    const falso = stripeFalso();
    const provider = new StripeProvider(falso.stripe, ['whsec_test']);

    const cap = await provider.capture({ idempotencyKey: 'ride_abc_capture', providerRef: 'pi_1' });

    expect(cap).toMatchObject({ captured: 11000, currency: 'USD', chargeRef: 'ch_1' });
    const [, params] = falso.llamadas['paymentIntents.capture'].args as [string, Record<string, unknown>];
    expect(params.amount_to_capture).toBeUndefined();
  });

  it('captura parcial cuando se cobra menos de lo retenido', async () => {
    const falso = stripeFalso({
      'paymentIntents.capture': { id: 'pi_1', amount: 11000, amount_received: 5500, currency: 'usd' },
    });
    const provider = new StripeProvider(falso.stripe, ['whsec_test']);

    const cap = await provider.capture({ idempotencyKey: 'k', providerRef: 'pi_1', amount: 5500 });

    const [, params] = falso.llamadas['paymentIntents.capture'].args as [string, Record<string, unknown>];
    expect(params.amount_to_capture).toBe(5500);
    expect(cap.captured).toBe(5500);
  });

  it('el reembolso se ancla al cobro, no al cargo', async () => {
    const falso = stripeFalso();
    const provider = new StripeProvider(falso.stripe, ['whsec_test']);

    const r = await provider.refund({ idempotencyKey: 'k', providerRef: 'pi_1', amount: 5000, reason: 'duplicate' });

    expect(r.providerRef).toBe('pi_1');
    expect(r.refunded).toBe(5000);
    const [params] = falso.llamadas['refunds.create'].args as [Stripe.RefundCreateParams];
    expect(params.payment_intent).toBe('pi_1');
    expect(params.reason).toBe('duplicate');
  });
});

describe('StripeProvider · repartir', () => {
  it('ata la transferencia al cargo del que sale', async () => {
    const falso = stripeFalso();
    const provider = new StripeProvider(falso.stripe, ['whsec_test']);

    await provider.transfer({
      idempotencyKey: 'driver_payout_ride-abc',
      payeeRef: 'acct_driver',
      amount: 9000,
      currency: 'USD',
      sourceRef: 'ch_1',
      reference: { rideId: 'ride-abc', beneficiaryId: 'drv-1' },
    });

    const [params] = falso.llamadas['transfers.create'].args as [Stripe.TransferCreateParams];
    // Sin source_transaction, la transferencia falla en cuanto el saldo de la
    // plataforma se vacía con los payouts automáticos de cada madrugada.
    expect(params.source_transaction).toBe('ch_1');
    expect(params.destination).toBe('acct_driver');
    expect(params.metadata).toMatchObject({ ride_id: 'ride-abc', beneficiary_id: 'drv-1' });
  });
});

describe('StripeProvider · estado del beneficiario', () => {
  it('sólo está activo si puede recibir transferencias', async () => {
    const falso = stripeFalso({ 'accounts.retrieve': { id: 'acct_1', capabilities: { transfers: 'active' } } });
    const provider = new StripeProvider(falso.stripe, ['whsec_test']);
    expect(await provider.payeeStatus('acct_1')).toBe('active');
  });

  it('haber rellenado el formulario no basta', async () => {
    // Fiarse de details_submitted dejó a choferes meses sin cobrar en urbont-api.
    const falso = stripeFalso({
      'accounts.retrieve': { id: 'acct_1', details_submitted: true, capabilities: { transfers: 'pending' } },
    });
    const provider = new StripeProvider(falso.stripe, ['whsec_test']);
    expect(await provider.payeeStatus('acct_1')).toBe('pending');
  });

  it('una cuenta bloqueada se marca como restringida', async () => {
    const falso = stripeFalso({
      'accounts.retrieve': {
        id: 'acct_1',
        capabilities: { transfers: 'inactive' },
        requirements: { disabled_reason: 'requirements.past_due' },
      },
    });
    const provider = new StripeProvider(falso.stripe, ['whsec_test']);
    expect(await provider.payeeStatus('acct_1')).toBe('restricted');
  });
});

describe('StripeProvider · webhooks', () => {
  const peticion = (cabeceras: Record<string, string | undefined>) => ({
    raw: Buffer.from('{"id":"evt_1"}'),
    headers: cabeceras,
  });

  it('rechaza un aviso sin firma', async () => {
    const falso = stripeFalso();
    const provider = new StripeProvider(falso.stripe, ['whsec_test']);
    await expect(provider.parseWebhook(peticion({}))).rejects.toThrow(FirmaInvalidaError);
  });

  it('rechaza si el servicio no tiene secretos configurados', async () => {
    const falso = stripeFalso();
    const provider = new StripeProvider(falso.stripe, []);
    await expect(provider.parseWebhook(peticion({ 'stripe-signature': 't=1,v1=abc' })))
      .rejects.toThrow(/ningún secreto/);
  });

  it('acepta el segundo secreto cuando el primero no valida (cuenta y Connect)', async () => {
    const falso = stripeFalso();
    const provider = new StripeProvider(falso.stripe, ['whsec_malo', 'whsec_bueno']);
    (falso.bruto.webhooks.constructEvent as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => { throw new Error('firma incorrecta'); })
      .mockImplementationOnce(() => ({
        id: 'evt_1', type: 'payment_intent.succeeded', created: 1_762_000_000,
        data: { object: { id: 'pi_1', amount: 11000, amount_received: 11000, currency: 'usd' } },
      }));

    const eventos = await provider.parseWebhook(peticion({ 'stripe-signature': 't=1,v1=abc' }));
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({ type: 'payment.captured', providerRef: 'pi_1' });
  });

  it('un evento irrelevante se acepta y no devuelve nada que procesar', async () => {
    const falso = stripeFalso();
    const provider = new StripeProvider(falso.stripe, ['whsec_test']);
    (falso.bruto.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'evt_2', type: 'customer.created', created: 1_762_000_000, data: { object: { id: 'cus_1' } },
    });

    await expect(provider.parseWebhook(peticion({ 'stripe-signature': 't=1,v1=abc' })))
      .resolves.toEqual([]);
  });

  it('si ningún secreto valida, no se procesa nada', async () => {
    const falso = stripeFalso();
    const provider = new StripeProvider(falso.stripe, ['whsec_a', 'whsec_b']);
    (falso.bruto.webhooks.constructEvent as ReturnType<typeof vi.fn>)
      .mockImplementation(() => { throw new Error('no match'); });

    await expect(provider.parseWebhook(peticion({ 'stripe-signature': 't=1,v1=abc' })))
      .rejects.toThrow(FirmaInvalidaError);
  });
});

describe('StripeProvider · capacidades', () => {
  it('declara que NO reparte en la captura', () => {
    const provider = new StripeProvider(stripeFalso().stripe, ['whsec_test']);
    // Es lo que permite que el registro elija otro procesador para una
    // operación que necesite repartir en el propio cobro.
    expect(provider.capabilities.splitAtCapture).toBe(false);
    expect(provider.capabilities.manualCapture).toBe(true);
    expect(provider.capabilities.tapToPay).toBe(true);
  });
});
