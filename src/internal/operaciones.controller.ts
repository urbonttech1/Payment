/**
 * Las dos tareas que alguien tiene que disparar de fuera.
 *
 * El servicio corre con dos tareas en ECS, así que un `setInterval` dentro las
 * ejecutaría dos veces: el cuadre saldría duplicado y los reintentos se
 * pisarían. En vez de añadir un planificador y un bloqueo, las dispara el cron
 * que ya existe en `urbont-api`, que es uno solo y ya sabe firmar.
 *
 * Van bajo `/internal`, con la misma firma que el resto: disparar un cuadre no
 * mueve dinero, pero lee el extracto entero del procesador y escribe en el
 * libro, y eso no lo hace cualquiera.
 */

import { Body, Controller, HttpCode, Post, UseFilters, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { WebhooksService, type ResultadoDeAviso } from '../webhooks/webhooks.service';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import type { ResultadoDelCuadre } from '../reconciliation/cuadre';
import { ErroresDePagoFilter } from './errores.filter';
import { FirmaGuard } from './firma.guard';

const cuerpoDeReintento = z.object({
  limite: z.number().int().min(1).max(500).default(50),
});

const cuerpoDeCuadre = z.object({
  provider: z.enum(['stripe', 'square', 'adyen', 'finix', 'paypal', 'ach']).optional(),
  desde: z.string().datetime().optional(),
  hasta: z.string().datetime().optional(),
});

@Controller('internal')
@UseGuards(FirmaGuard)
@UseFilters(ErroresDePagoFilter)
export class OperacionesController {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly conciliacion: ReconciliationService,
  ) {}

  /**
   * Vuelve a procesar los avisos que se guardaron y fallaron.
   *
   * Stripe se rinde a los tres días; esta cola no se rinde. Es seguro llamarlo
   * tantas veces como haga falta: cada efecto es idempotente.
   */
  @Post('webhooks/retry')
  @HttpCode(200)
  async reintentar(@Body() body: unknown): Promise<ResultadoDeAviso> {
    const r = cuerpoDeReintento.safeParse(body ?? {});
    return this.webhooks.reintentarPendientes(r.success ? r.data.limite : 50);
  }

  /** Cuadra un período contra el extracto del procesador y lo guarda. */
  @Post('reconciliation/run')
  @HttpCode(200)
  async cuadrar(@Body() body: unknown): Promise<ResultadoDelCuadre> {
    const r = cuerpoDeCuadre.safeParse(body ?? {});
    const datos = r.success ? r.data : {};
    return this.conciliacion.cuadrar({
      ...(datos.provider ? { provider: datos.provider } : {}),
      ...(datos.desde ? { desde: new Date(datos.desde) } : {}),
      ...(datos.hasta ? { hasta: new Date(datos.hasta) } : {}),
    });
  }
}
