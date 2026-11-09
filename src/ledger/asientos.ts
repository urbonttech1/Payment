/**
 * Los asientos de un reembolso, construidos en un solo sitio.
 *
 * Un reembolso llega por dos caminos: lo pedimos nosotros
 * (`PaymentsService.reembolsar`) o nos lo cuenta el procesador (un webhook). Y
 * normalmente llega por los dos, porque pedirlo provoca el aviso.
 *
 * Si cada camino construyera sus asientos, el libro contaría la devolución dos
 * veces y el cuadre empezaría a mentir. Por eso la clave sale de **la
 * referencia del reembolso en el procesador** (`re_…`), que es lo único que los
 * dos caminos conocen: el que llegue segundo no escribe nada.
 *
 * Y por eso esta función es pura y vive aquí, y no dentro de ninguno de los dos.
 */

import type { Cents, Currency, ProviderName } from '../providers/provider.port';
import type { NuevoAsiento } from './entries.repository';

export interface ReembolsoParaAsentar {
  transactionId: string;
  /** La referencia del reembolso en el procesador. Es la identidad del asiento. */
  refundRef: string;
  devueltoCents: Cents;
  currency: Currency;
  provider: ProviderName;
  memo?: string;
}

/**
 * Dos asientos que suman cero: sale del saldo y reduce el ingreso.
 *
 * Que salga de la parte de la plataforma es la verdad y no una simplificación:
 * el procesador saca el dinero del saldo de URBONT. Si al chofer ya se le había
 * pagado lo suyo, la devolución la absorbe la plataforma; recuperarla de él es
 * una decisión de negocio, no un asiento.
 */
export function asientosDeReembolso(r: ReembolsoParaAsentar): NuevoAsiento[] {
  const base = {
    transactionId: r.transactionId,
    entryType: 'refund' as const,
    currency: r.currency,
    provider: r.provider,
    providerRef: r.refundRef,
  };

  return [
    {
      ...base,
      entryKey: `${r.transactionId}:refund:${r.refundRef}:clearing`,
      account: 'clearing',
      amountCents: -r.devueltoCents,
      memo: r.memo ?? 'reembolso al pasajero',
    },
    {
      ...base,
      entryKey: `${r.transactionId}:refund:${r.refundRef}:platform`,
      account: 'platform_revenue',
      amountCents: r.devueltoCents,
      memo: 'el reembolso sale de la parte de la plataforma',
    },
  ];
}
