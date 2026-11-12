/**
 * El servicio de pagos manuales, con el libro y las cuentas en memoria.
 *
 * Lo que de verdad se comprueba aquí es que **el importe lo pone el libro**, no
 * quien llama, y que lo que se manda al registrar un pago llega entero a la
 * capa que lo guarda.
 *
 * Esto último tiene una historia: `documentPath` se aceptaba en las opciones y
 * se perdía por el camino, porque el tipo de la capa de abajo no lo declaraba.
 * El typecheck pasaba —la opción existía— y el comprobante nunca llegaba a la
 * base, así que el correo salía sin enlace. Un campo que se acepta y se tira es
 * peor que uno que no existe: parece que funciona.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PayoutsService, NadaQuePagarError, SinCuentaDeCobroError } from './payouts.service';
import type { Config } from '../config/config';
import type { SplitsRepository } from '../splits/splits.repository';
import type {
  CuentaParaElPanel,
  NuevoPago,
  PayoutAccountsRepository,
  PayoutsRepository,
} from './payouts.repository';

const CHOFER = '11111111-1111-4111-8111-111111111111';

const cuenta: CuentaParaElPanel = {
  payeeId: CHOFER,
  payeeType: 'driver',
  method: 'ach',
  holderName: 'Paulo Estrada',
  bankName: 'Chase',
  pista: '****4821',
  status: 'verified',
  statusReason: null,
  updatedBy: null,
  updatedAt: new Date(),
};

function parte(id: string, amountCents: number) {
  return {
    id,
    transactionId: 'tx-1',
    beneficiaryType: 'driver' as const,
    beneficiaryId: CHOFER,
    amountCents,
    deductionCents: 0,
    rate: null,
    status: 'pending' as const,
    provider: null,
    providerTransferRef: null,
    failureCode: null,
    memo: null,
    paidAt: null,
    createdAt: new Date('2026-11-10T12:00:00Z'),
    settlementMode: 'manual' as const,
    payoutId: null,
  };
}

describe('registrar un pago manual', () => {
  let partes: SplitsRepository;
  let cuentas: PayoutAccountsRepository;
  let pagos: PayoutsRepository;
  let servicio: PayoutsService;
  let recibido: NuevoPago | null;

  beforeEach(() => {
    recibido = null;
    partes = {
      pendientesDe: vi.fn(async () => [parte('s1', 7400), parte('s2', 2600)]),
      saldos: vi.fn(async () => []),
    } as unknown as SplitsRepository;

    cuentas = { obtener: vi.fn(async () => cuenta) } as unknown as PayoutAccountsRepository;

    pagos = {
      pagarYSaldar: vi.fn(async (p: NuevoPago) => {
        recibido = p;
        return {
          pago: { ...p, id: 'pay-1', paidAt: new Date(), documentPath: p.documentPath ?? null } as never,
          partesSaldadas: 2,
        };
      }),
    } as unknown as PayoutsRepository;

    servicio = new PayoutsService({ CREDENTIALS_KEY: undefined } as Config, partes, cuentas, pagos);
  });

  it('el importe sale del libro, no de quien llama', async () => {
    await servicio.pagar(CHOFER, 'ach', 'ricardo@urbont.com');

    // 7400 + 2600. Un importe editable desde el panel sería un panel que puede
    // regalar dinero.
    expect(recibido?.amountCents).toBe(10000);
  });

  it('el comprobante llega entero a la capa que lo guarda', async () => {
    await servicio.pagar(CHOFER, 'ach', 'ricardo@urbont.com', {
      reference: 'CONF-998',
      documentPath: `${CHOFER}/recibo.pdf`,
    });

    // El fallo que esto fija: se aceptaba y se perdía, y el correo salía sin
    // enlace al comprobante sin que nada avisara.
    expect(recibido?.documentPath).toBe(`${CHOFER}/recibo.pdf`);
    expect(recibido?.reference).toBe('CONF-998');
  });

  it('el período cubre desde la parte más vieja hasta la más nueva', async () => {
    await servicio.pagar(CHOFER, 'ach', 'ricardo@urbont.com');

    expect(recibido?.periodStart).toBeInstanceOf(Date);
    expect(recibido?.periodEnd).toBeInstanceOf(Date);
  });

  it('no se le paga a quien no ha dicho dónde cobra', async () => {
    cuentas = { obtener: vi.fn(async () => null) } as unknown as PayoutAccountsRepository;
    servicio = new PayoutsService({ CREDENTIALS_KEY: undefined } as Config, partes, cuentas, pagos);

    await expect(servicio.pagar(CHOFER, 'ach', 'ricardo@urbont.com')).rejects.toThrow(SinCuentaDeCobroError);
    expect(pagos.pagarYSaldar).not.toHaveBeenCalled();
  });

  it('no se registra un pago de cero', async () => {
    partes = { pendientesDe: vi.fn(async () => []), saldos: vi.fn(async () => []) } as unknown as SplitsRepository;
    servicio = new PayoutsService({ CREDENTIALS_KEY: undefined } as Config, partes, cuentas, pagos);

    await expect(servicio.pagar(CHOFER, 'ach', 'ricardo@urbont.com')).rejects.toThrow(NadaQuePagarError);
  });
});
