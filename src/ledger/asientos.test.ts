import { describe, expect, it } from 'vitest';
import { asientosDeReembolso } from './asientos';

const BASE = {
  transactionId: 'tx-1',
  refundRef: 're_1',
  devueltoCents: 500,
  currency: 'USD' as const,
  provider: 'stripe' as const,
};

describe('los asientos de un reembolso', () => {
  it('suman cero: sale del saldo y reduce el ingreso', () => {
    const a = asientosDeReembolso(BASE);
    expect(a.reduce((t, x) => t + x.amountCents, 0)).toBe(0);
    expect(a.find((x) => x.account === 'clearing')?.amountCents).toBe(-500);
    expect(a.find((x) => x.account === 'platform_revenue')?.amountCents).toBe(500);
  });

  // La razón de que esta función exista. Un reembolso llega por dos caminos
  // —lo pedimos nosotros y el procesador nos lo cuenta— y normalmente por los
  // dos. Si las claves no coincidieran, el libro contaría la devolución dos
  // veces y el cuadre empezaría a mentir.
  it('LA CLAVE SÓLO DEPENDE DEL COBRO Y DE LA REFERENCIA DEL REEMBOLSO', () => {
    const pedido = asientosDeReembolso({ ...BASE, memo: 'reembolso (duplicate)' });
    const avisado = asientosDeReembolso(BASE);

    expect(pedido.map((x) => x.entryKey)).toEqual(avisado.map((x) => x.entryKey));
    expect(pedido[0].entryKey).toBe('tx-1:refund:re_1:clearing');
  });

  it('dos reembolsos distintos del mismo cobro son dos asientos', () => {
    const uno = asientosDeReembolso(BASE);
    const otro = asientosDeReembolso({ ...BASE, refundRef: 're_2' });
    expect(uno[0].entryKey).not.toBe(otro[0].entryKey);
  });

  it('el memo no entra en la clave, porque no es parte de la identidad', () => {
    const a = asientosDeReembolso({ ...BASE, memo: 'cualquier cosa' });
    expect(a[0].entryKey).toBe('tx-1:refund:re_1:clearing');
    expect(a[0].memo).toBe('cualquier cosa');
  });
});
