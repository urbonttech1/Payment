/**
 * El cobro en persona, con el teléfono del chofer como lector.
 *
 * Dos rutas, y la primera es la que hace que esto sea intercambiable: el SDK
 * que corre en el teléfono no puede empezar sin un token que sólo el backend
 * puede pedir, y ese token es lo más propio de cada procesador que hay en todo
 * el sistema. Pidiéndolo aquí, la app no tiene que saber cuál está activo.
 *
 * El cobro va por el libro como cualquier otro, que es lo que hoy no pasa: el
 * cobro presencial se crea en Stripe y de él sólo se entera el webhook. Un
 * cobro que no está en el libro no se puede conciliar, y es dinero en efectivo
 * de la cuenta de alguien.
 */

import { BadRequestException, Body, Controller, HttpCode, Param, Post, UseFilters, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { PaymentsService } from '../payments/payments.service';
import type { TerminalSession } from '../providers/provider.port';
import { ErroresDePagoFilter } from './errores.filter';
import { FirmaGuard } from './firma.guard';

const CENTAVOS = z.number().int().positive().max(99_999_999);

const cuerpoDeCobroPresencial = z.object({
  kind: z.enum(['ride', 'tip', 'cleaning', 'hourly_extra', 'cancellation_fee', 'no_show_fee', 'penalty']),
  amountCents: CENTAVOS,
  currency: z.enum(['USD', 'COP', 'EUR', 'MXN']).default('USD'),
  taxCents: z.number().int().min(0).max(99_999_999).optional(),
  rideId: z.string().uuid().optional(),
  payerId: z.string().uuid().optional(),
  description: z.string().min(1).max(200).optional(),
  /** El lector concreto, si el procesador los distingue. */
  terminalRef: z.string().min(1).max(128).optional(),
  metadata: z.record(z.string().max(64), z.string().max(500)).optional(),
  /**
   * El procesador que prefiere quien llama. Una app ya publicada espera el cobro
   * presencial de Stripe aunque el procesador por defecto sea Square: `urbont-api`
   * lo pide por ella. Si no se puede cumplir, el servicio elige como siempre.
   */
  provider: z.enum(['stripe', 'square', 'adyen', 'finix', 'paypal', 'ach']).optional(),
});

/** La clave la deriva quien llama del viaje y del intento, nunca aleatoria. */
const CLAVE = z.string().min(8).max(200).regex(/^[A-Za-z0-9_.:-]+$/);

const cuerpoDeSesion = z.object({
  provider: z.enum(['stripe', 'square', 'adyen', 'finix', 'paypal', 'ach']).optional(),
});

const cuerpoDeAdopcion = z.object({
  /** El id del pago en el procesador, tal como lo dio el SDK del teléfono. */
  providerRef: z.string().min(1).max(200),
});

interface RespuestaDeSesion {
  provider: string;
  token: string;
  locationRef?: string;
  /** El id público de nuestra aplicación, si el SDK del teléfono lo pide para arrancar. */
  applicationRef?: string;
  /** Quién crea el cobro; ver `TerminalSession.flow`. */
  flow?: 'server-intent' | 'device-sdk';
  expiresAt?: string;
}

@Controller('internal/terminal')
@UseGuards(FirmaGuard)
@UseFilters(ErroresDePagoFilter)
export class TerminalController {
  constructor(private readonly payments: PaymentsService) {}

  /**
   * El token de sesión del lector.
   *
   * Dura minutos y no se guarda: se pide uno por sesión de cobro. Por eso es un
   * POST y no un GET, aunque no cambie nada nuestro: pedirlo tiene coste en el
   * procesador y no debe quedarse en ninguna caché.
   */
  @Post('session')
  @HttpCode(200)
  async sesion(@Body() body: unknown): Promise<RespuestaDeSesion> {
    const datos = cuerpoDeSesion.safeParse(body ?? {});
    if (!datos.success) {
      throw new BadRequestException({
        error: 'INVALID_REQUEST',
        detalle: datos.error.issues.map((i) => `${i.path.join('.') || 'cuerpo'}: ${i.message}`).join('; '),
      });
    }

    const s: TerminalSession = await this.payments.sesionDeTerminal(datos.data.provider);
    return {
      provider: s.provider,
      token: s.token,
      ...(s.locationRef ? { locationRef: s.locationRef } : {}),
      ...(s.applicationRef ? { applicationRef: s.applicationRef } : {}),
      ...(s.flow ? { flow: s.flow } : {}),
      ...(s.expiresAt ? { expiresAt: s.expiresAt.toISOString() } : {}),
    };
  }

  /**
   * Prepara el cobro presencial.
   *
   * Devuelve el secreto con el que el SDK del teléfono lo remata. Hasta que lo
   * remate, el cobro **no ha ocurrido**, y el libro lo dice: la fila queda en
   * `pending` con su referencia.
   */
  @Post('charges')
  @HttpCode(200)
  async cobrar(
    @Body() body: unknown,
  ): Promise<{
    chargeKey: string;
    status: string;
    provider: string;
    providerRef: string | null;
    clientSecret?: string;
    /** Quién crea el cobro: el servidor (`server-intent`) o el SDK del teléfono (`device-sdk`). */
    flow: 'server-intent' | 'device-sdk';
    /** Sólo con `device-sdk`: lo que el SDK pone en el pago para poder adoptarlo después. */
    referenceId?: string;
    paymentAttemptId?: string;
    amountCents: number;
  }> {
    const datos = cuerpoDeCobroPresencial.and(z.object({ chargeKey: CLAVE })).safeParse(body ?? {});
    if (!datos.success) {
      throw new BadRequestException({
        error: 'INVALID_REQUEST',
        detalle: datos.error.issues.map((i) => `${i.path.join('.') || 'cuerpo'}: ${i.message}`).join('; '),
      });
    }

    const { chargeKey, provider, ...resto } = datos.data;
    const { transaccion, autorizacion, dispositivo } = await this.payments.cobrarEnPersona({
      idempotencyKey: chargeKey,
      // En persona se cobra en el acto: no hay nada que retener.
      hold: false,
      ...(provider ? { proveedor: provider } : {}),
      ...resto,
    });

    return {
      chargeKey: transaccion.idempotencyKey,
      status: transaccion.status,
      provider: transaccion.provider,
      providerRef: transaccion.providerRef,
      ...(autorizacion?.clientSecret ? { clientSecret: autorizacion.clientSecret } : {}),
      flow: dispositivo ? 'device-sdk' : 'server-intent',
      ...(dispositivo ? { referenceId: dispositivo.referenceId, paymentAttemptId: dispositivo.paymentAttemptId } : {}),
      amountCents: transaccion.amountCents,
    };
  }

  /**
   * Da por cobrado el pago que el SDK del teléfono ya hizo (`flow: 'device-sdk'`).
   *
   * El teléfono dice «cobré este pago»; aquí se lee del procesador y se comprueba
   * contra lo que el servidor esperaba antes de apuntarlo. Un pago que no es el
   * esperado sale como un 422 con el `motivo`: no es un error del servicio.
   */
  @Post('charges/:clave/adopt')
  @HttpCode(200)
  async adoptar(
    @Param('clave') clave: string,
    @Body() body: unknown,
  ): Promise<{
    chargeKey: string;
    status: string;
    provider: string;
    providerRef: string | null;
    amountCents: number;
    /** `urbont-api` lo guarda en el viaje al dar el cobro por bueno. */
    taxCents: number;
  }> {
    const clave_ = CLAVE.safeParse(clave);
    const datos = cuerpoDeAdopcion.safeParse(body ?? {});
    if (!clave_.success || !datos.success) {
      throw new BadRequestException({
        error: 'INVALID_REQUEST',
        detalle: [
          ...(clave_.success ? [] : ['clave: no es válida']),
          ...(datos.success ? [] : datos.error.issues.map((i) => `${i.path.join('.') || 'cuerpo'}: ${i.message}`)),
        ].join('; '),
      });
    }

    const tx = await this.payments.adoptarCobroPresencial(clave_.data, datos.data.providerRef);
    return {
      chargeKey: tx.idempotencyKey,
      status: tx.status,
      provider: tx.provider,
      providerRef: tx.providerRef,
      amountCents: tx.amountCents,
      taxCents: tx.taxCents,
    };
  }
}
