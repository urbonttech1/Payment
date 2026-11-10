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

import { BadRequestException, Body, Controller, Get, HttpCode, Post, UseFilters, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { SettingsService, esProcesador, type RuteoGuardado } from '../config/settings.service';
import { WebhooksService, type ResultadoDeAviso } from '../webhooks/webhooks.service';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import type { ResultadoDelCuadre } from '../reconciliation/cuadre';
import { ErroresDePagoFilter } from './errores.filter';
import { FirmaGuard } from './firma.guard';

const cuerpoDeReintento = z.object({
  limite: z.number().int().min(1).max(500).default(50),
});

const cuerpoDeRuteo = z.object({
  defaultProvider: z.string().min(2).max(20),
  /** Quién lo cambió. Lo pone urbont-api desde su sesión de admin. */
  updatedBy: z.string().min(1).max(200),
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
    private readonly settings: SettingsService,
  ) {}

  /**
   * Qué procesador atiende los cobros nuevos, y cuáles podría atenderlos.
   *
   * «Disponibles» son los que tienen credenciales montadas en esta instalación,
   * no los que el contrato sabe nombrar: ofrecer en el panel uno sin
   * credenciales sería ofrecer una forma de dejar de cobrar.
   */
  @Get('config')
  async configVigente(): Promise<RuteoGuardado & { disponibles: string[] }> {
    return { ...this.settings.vigente(), disponibles: this.settings.disponibles() };
  }

  /**
   * Cambia el procesador de los cobros nuevos.
   *
   * No toca ningún cobro existente: cada uno vuelve al procesador que lo
   * originó, que es la regla 1 del contrato. Lo que cambia es a partir de cuándo.
   */
  @Post('config/routing')
  @HttpCode(200)
  async cambiarRuteo(@Body() body: unknown): Promise<RuteoGuardado & { disponibles: string[] }> {
    const datos = cuerpoDeRuteo.safeParse(body ?? {});
    if (!datos.success) {
      throw new BadRequestException({ error: 'INVALID_REQUEST', detalle: 'defaultProvider y updatedBy son obligatorios' });
    }
    if (!esProcesador(datos.data.defaultProvider)) {
      throw new BadRequestException({ error: 'INVALID_REQUEST', detalle: 'ese procesador no existe' });
    }
    const guardado = await this.settings.guardar(
      { defaultProvider: datos.data.defaultProvider },
      datos.data.updatedBy,
    );
    return { ...guardado, disponibles: this.settings.disponibles() };
  }

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
