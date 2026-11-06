/**
 * La puerta de `urbont-api` al dinero.
 *
 * Cinco rutas y nada más, cada una un caso de uso. No las llama la app: las
 * llama el backend, firmadas, y por eso viven bajo `/internal`.
 *
 * Dos cosas gobiernan el diseño:
 *
 *  · **El cobro se direcciona por su clave de idempotencia**, no por un id que
 *    tendríamos que devolver y que el otro lado tendría que guardar. La clave la
 *    deriva quien llama del viaje y de la operación (`ride_<id>_authorize`), así
 *    que puede volver a nombrarla sin haber guardado nada. Un reintento después
 *    de un timeout nombra exactamente el mismo cobro.
 *  · **El importe lo resuelve quien llama**, contra el viaje, antes de pedirlo.
 *    Nunca llega de un cliente. Mientras `urbont-api` sea el único que llama,
 *    esta ruta hereda esa garantía; cuando el micro resuelva el importe él mismo
 *    (fase 4), la heredará de su propia base.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { PaymentsService, type PeticionDeCobro } from '../payments/payments.service';
import { SplitsService, type PeticionDeReparto, type ResultadoDeReparto } from '../splits/splits.service';
import type { Transaction } from '../ledger/transactions.repository';
import { TransaccionNoEncontradaError } from '../payments/payments.service';
import { ErroresDePagoFilter } from './errores.filter';
import { FirmaGuard } from './firma.guard';

const KIND = z.enum(['ride', 'tip', 'cleaning', 'hourly_extra', 'cancellation_fee', 'no_show_fee', 'penalty']);
const MONEDA = z.enum(['USD', 'COP', 'EUR', 'MXN']);
const CENTAVOS = z.number().int().positive().max(99_999_999);

const cuerpoDeCobro = z.object({
  kind: KIND,
  amountCents: CENTAVOS,
  currency: MONEDA.default('USD'),
  taxCents: z.number().int().min(0).max(99_999_999).optional(),
  /** `true` retiene y se cobra al terminar; `false` cobra en el acto. */
  hold: z.boolean(),
  // uuid y no una cadena cualquiera: las columnas `ride_id` y `payer_id` del
  // libro son uuid, así que cualquier otra cosa muere en el INSERT con un 500
  // en vez de decirle a quien llama que su petición estaba mal.
  rideId: z.string().uuid().optional(),
  payerId: z.string().uuid().optional(),
  customerRef: z.string().min(1).max(128).optional(),
  cardRef: z.string().min(1).max(128).optional(),
  metadata: z.record(z.string().max(64), z.string().max(500)).optional(),
});

const cuerpoDeCaptura = z.object({ amountCents: CENTAVOS.optional() });

const CENTAVOS_0 = z.number().int().min(0).max(99_999_999);

const cuerpoDeReparto = z.object({
  taxCents: CENTAVOS_0.optional(),
  valetCents: CENTAVOS_0.optional(),
  bookingFeeCents: CENTAVOS_0.optional(),
  accessFeeCents: CENTAVOS_0.optional(),
  /** Si no viene, la del servicio (`PLATFORM_COMMISSION_RATE`). */
  commissionRate: z.number().min(0).max(0.5).optional(),
  driverDeductionCents: CENTAVOS_0.optional(),
  driverDeductionMemo: z.string().max(200).optional(),
  beneficiarios: z
    .array(
      z.object({
        type: z.enum(['driver', 'valet']),
        id: z.string().uuid(),
        /** Su cuenta en el procesador. Sólo se usa la primera vez. */
        payeeRef: z.string().min(1).max(128).optional(),
        country: z.string().length(2).optional(),
      }),
    )
    .max(4)
    .default([]),
  /** Modo sombra: calcula y apunta, sin mover un centavo. */
  dryRun: z.boolean().default(false),
});

const cuerpoDeReembolso = z.object({
  amountCents: CENTAVOS.optional(),
  reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer']).optional(),
});

/** La clave viaja en la ruta; se acota para que no entre cualquier cosa. */
const CLAVE = z.string().min(8).max(200).regex(/^[A-Za-z0-9_.:-]+$/);

function validar<T extends z.ZodTypeAny>(esquema: T, valor: unknown): z.infer<T> {
  const r = esquema.safeParse(valor);
  if (!r.success) {
    throw new BadRequestException({
      error: 'INVALID_REQUEST',
      detalle: r.error.issues.map((i) => `${i.path.join('.') || 'cuerpo'}: ${i.message}`).join('; '),
    });
  }
  return r.data;
}

/** Lo que ve `urbont-api`. Nada del procesador asoma por aquí salvo su nombre. */
interface RespuestaDeCobro {
  chargeKey: string;
  status: Transaction['status'];
  provider: Transaction['provider'];
  providerRef: string | null;
  kind: Transaction['kind'];
  rideId: string | null;
  amountCents: number;
  taxCents: number;
  currency: Transaction['currency'];
  clientSecret?: string;
  capturedAt?: string | null;
}

function aRespuesta(tx: Transaction, clientSecret?: string | null): RespuestaDeCobro {
  return {
    chargeKey: tx.idempotencyKey,
    status: tx.status,
    provider: tx.provider,
    providerRef: tx.providerRef,
    kind: tx.kind,
    rideId: tx.rideId,
    amountCents: tx.amountCents,
    taxCents: tx.taxCents,
    currency: tx.currency,
    ...(clientSecret ? { clientSecret } : {}),
    capturedAt: tx.capturedAt ? tx.capturedAt.toISOString() : null,
  };
}

@Controller('internal/charges')
@UseGuards(FirmaGuard)
@UseFilters(ErroresDePagoFilter)
export class ChargesController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly splits: SplitsService,
  ) {}

  /**
   * Autoriza (o cobra) un importe.
   *
   * La clave va en la cabecera y no en el cuerpo a propósito: es de la
   * *petición*, no del cobro, y así un proxy o un registro la ven sin abrir el
   * cuerpo. Repetir la llamada con la misma clave devuelve el mismo cobro.
   */
  @Post()
  @HttpCode(200)
  async autorizar(
    @Headers('idempotency-key') clave: string | undefined,
    @Body() body: unknown,
  ): Promise<RespuestaDeCobro> {
    const idempotencyKey = validar(CLAVE, clave);
    const datos = validar(cuerpoDeCobro, body);

    const peticion: PeticionDeCobro = { idempotencyKey, ...datos };
    const { transaccion, autorizacion } = await this.payments.autorizar(peticion);

    return aRespuesta(transaccion, autorizacion?.clientSecret);
  }

  /** Cobra lo retenido. Con `amountCents` mayor, sube antes la autorización. */
  @Post(':clave/capture')
  @HttpCode(200)
  async capturar(@Param('clave') clave: string, @Body() body: unknown): Promise<RespuestaDeCobro> {
    const { amountCents } = validar(cuerpoDeCaptura, body ?? {});
    return aRespuesta(await this.payments.capturar(validar(CLAVE, clave), amountCents));
  }

  /** Suelta una retención que nunca llegó a cobrarse. */
  @Post(':clave/void')
  @HttpCode(200)
  async anular(@Param('clave') clave: string): Promise<RespuestaDeCobro> {
    return aRespuesta(await this.payments.anular(validar(CLAVE, clave)));
  }

  /** Devuelve dinero ya cobrado, entero o en parte. */
  @Post(':clave/refund')
  @HttpCode(200)
  async reembolsar(@Param('clave') clave: string, @Body() body: unknown) {
    const opciones = validar(cuerpoDeReembolso, body ?? {});
    const { transaccion, reembolso } = await this.payments.reembolsar(
      validar(CLAVE, clave),
      opciones,
    );
    return {
      ...aRespuesta(transaccion),
      refund: { providerRef: reembolso.providerRef, refundedCents: reembolso.refunded },
    };
  }

  /**
   * Reparte un cobro ya capturado entre el chofer, el valet y URBONT.
   *
   * El importe NO viene en el cuerpo: sale de lo que el libro dice que se
   * capturó. Lo que viene son los datos que el micro no tiene todavía —el
   * impuesto, el recargo del valet, el booking, el aeropuerto y la comisión
   * vigente—, que hoy siguen viviendo en la base de `urbont-api`.
   *
   * Con `dryRun`, calcula y apunta el reparto sin mover dinero: es el modo con
   * el que se enciende esto en producción, comparando contra lo que hizo
   * `urbont-api` antes de dejarle pagar de verdad.
   */
  @Post(':clave/settle')
  @HttpCode(200)
  async liquidar(@Param('clave') clave: string, @Body() body: unknown): Promise<ResultadoDeReparto> {
    const datos = validar(cuerpoDeReparto, body ?? {});
    return this.splits.liquidar(validar(CLAVE, clave), datos as PeticionDeReparto);
  }

  /** El reparto de un cobro, tal como esté. No calcula ni paga nada. */
  @Get(':clave/splits')
  async reparto(@Param('clave') clave: string): Promise<ResultadoDeReparto> {
    const validada = validar(CLAVE, clave);
    const r = await this.splits.consultar(validada);
    if (!r) throw new TransaccionNoEncontradaError(validada);
    return r;
  }

  /**
   * El cobro con esa clave, o 404.
   *
   * Es la pregunta «¿este cobro es tuyo?». `urbont-api` la necesita para los
   * viajes autorizados **antes** de encender el interruptor: el micro no los
   * conoce, y hay que capturarlos por el camino viejo.
   */
  @Get(':clave')
  async consultar(@Param('clave') clave: string): Promise<RespuestaDeCobro> {
    const validada = validar(CLAVE, clave);
    const tx = await this.payments.porClave(validada);
    if (!tx) throw new TransaccionNoEncontradaError(validada);
    return aRespuesta(tx);
  }
}
