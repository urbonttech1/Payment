/**
 * El cuadre diario.
 *
 * Trae el extracto del procesador, trae nuestro libro del mismo período, los
 * compara con la función pura de `cuadre.ts` y guarda el resultado. Un
 * descuadre que nadie mira es un descuadre que crece, así que queda apuntado en
 * `payments.reconciliation_runs` y, si no cuadra, grita en el registro.
 *
 * No lo dispara un reloj propio: el servicio corre con dos tareas y un
 * `setInterval` dentro haría el cuadre dos veces. Lo llama el cron que ya
 * existe en `urbont-api`, por el endpoint interno.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProviderRegistry } from '../providers/provider.registry';
import {
  TRANSACTIONS_REPOSITORY,
  type TransactionsRepository,
} from '../ledger/transactions.repository';
import type { ProviderName } from '../providers/provider.port';
import {
  RECONCILIATION_REPOSITORY,
  type ReconciliationRepository,
} from './reconciliation.repository';
import { compararExtracto, lineaDelCuadre, type ResultadoDelCuadre } from './cuadre';

/** Tope de líneas por lado. Un cuadre no puede tragarse la memoria del proceso. */
const TOPE = 2_000;

@Injectable()
export class ReconciliationService {
  private readonly log = new Logger(ReconciliationService.name);

  constructor(
    private readonly registry: ProviderRegistry,
    @Inject(TRANSACTIONS_REPOSITORY) private readonly transacciones: TransactionsRepository,
    @Inject(RECONCILIATION_REPOSITORY) private readonly cuadres: ReconciliationRepository,
  ) {}

  /**
   * Cuadra un período y lo guarda.
   *
   * Por defecto, el día anterior completo: es el primer momento en que el
   * extracto del procesador está cerrado y comparar tiene sentido.
   */
  async cuadrar(opciones: { provider?: ProviderName; desde?: Date; hasta?: Date } = {}): Promise<ResultadoDelCuadre> {
    const hasta = opciones.hasta ?? new Date();
    const desde = opciones.desde ?? new Date(hasta.getTime() - 24 * 60 * 60 * 1000);

    const adaptador = opciones.provider
      ? this.registry.paraCobroExistente(opciones.provider)
      : this.registry.paraCobroNuevo();
    const provider = adaptador.name;

    const [extracto, libro] = await Promise.all([
      adaptador.listCharges(desde, hasta, TOPE),
      this.transacciones.capturadasEntre(provider, desde, hasta, TOPE),
    ]);

    const resultado = compararExtracto(
      provider,
      extracto.map((c) => ({
        chargeRef: c.chargeRef,
        providerRef: c.providerRef,
        netoCents: c.netCents,
        createdAt: c.createdAt,
      })),
      libro,
    );

    await this.cuadres.guardar({ ...resultado, desde, hasta });

    const linea = lineaDelCuadre(resultado);
    if (resultado.cuadra) this.log.log(linea);
    else this.log.error(linea);

    return resultado;
  }
}
