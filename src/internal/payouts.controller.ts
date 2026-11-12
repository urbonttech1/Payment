/**
 * Lo que el panel necesita para pagarle a choferes y valets a mano.
 *
 * Va bajo `/internal` y firmado, como todo lo demás: aquí se leen datos
 * bancarios y se dan deudas por saldadas, que es de las cosas más delicadas que
 * hace el servicio.
 *
 * Quién puede llamar a cada ruta lo decide `urbont-api` con su sesión de admin
 * —esto no conoce usuarios—, pero el `updatedBy` viaja en el cuerpo y se
 * guarda: un pago sin nombre detrás no se puede auditar.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  PayoutsService,
  NadaQuePagarError,
  SinCuentaDeCobroError,
} from '../payouts/payouts.service';
import { ImporteNoCuadraError } from '../payouts/payouts.repository';
import { ErroresDePagoFilter } from './errores.filter';
import { FirmaGuard } from './firma.guard';

const uuid = z.string().uuid();

const cuerpoDeCuenta = z.object({
  payeeType: z.enum(['driver', 'valet']),
  method: z.enum(['ach', 'zelle']),
  holderName: z.string().min(1).max(200),
  bankName: z.string().max(200).optional(),
  routingNumber: z.string().max(32).optional(),
  accountNumber: z.string().max(64).optional(),
  zelleEmail: z.string().max(200).optional(),
  updatedBy: z.string().min(1).max(200),
});

/**
 * Lo que se manda para registrar un pago.
 *
 * **No lleva importe, a propósito.** Lo que se paga sale del libro: un importe
 * editable desde el panel es un panel que puede regalar dinero.
 */
const cuerpoDePago = z.object({
  method: z.enum(['ach', 'zelle', 'cash', 'other']),
  reference: z.string().max(200).optional(),
  notes: z.string().max(1000).optional(),
  updatedBy: z.string().min(1).max(200),
});

const cuerpoDeEstado = z.object({
  motivo: z.string().max(500).optional(),
  updatedBy: z.string().min(1).max(200),
});

@Controller('internal/payouts')
@UseGuards(FirmaGuard)
@UseFilters(ErroresDePagoFilter)
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  /** Lo que se le debe a cada persona, con su cuenta de cobro al lado. */
  @Get('balances')
  balances() {
    return this.payouts.saldos();
  }

  @Get('accounts')
  cuentas() {
    return this.payouts.listarCuentas();
  }

  /** Las partes sueltas que componen el saldo de una persona. */
  @Get(':payeeId/history')
  async historial(@Param('payeeId') payeeId: string, @Query('limite') limite?: string) {
    this.validarId(payeeId);
    return this.payouts.historial(payeeId, Number(limite) || 50);
  }

  @Get('recent')
  recientes(@Query('limite') limite?: string) {
    return this.payouts.recientes(Number(limite) || 50);
  }

  @Post(':payeeId/account')
  async registrarCuenta(@Param('payeeId') payeeId: string, @Body() cuerpo: unknown) {
    this.validarId(payeeId);
    const c = this.parsear(cuerpoDeCuenta, cuerpo);

    try {
      return await this.payouts.registrarCuenta(
        payeeId,
        c.payeeType,
        c.method,
        c.holderName,
        {
          routingNumber: c.routingNumber,
          accountNumber: c.accountNumber,
          zelleEmail: c.zelleEmail,
        },
        c.updatedBy,
        c.bankName,
      );
    } catch (e) {
      // Un dato bancario mal tecleado es error de quien lo escribe, no del
      // servicio: 400 y el motivo, para que pueda arreglarlo.
      throw new BadRequestException(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Los datos bancarios en claro, para el momento de transferir.
   *
   * Es la única ruta que los devuelve, y deja rastro de quién los pidió.
   */
  @Get(':payeeId/bank-details')
  async datosBancarios(@Param('payeeId') payeeId: string, @Query('updatedBy') quien?: string) {
    this.validarId(payeeId);
    if (!quien) throw new BadRequestException('Falta updatedBy: estos datos no se consultan sin nombre detrás.');
    try {
      return await this.payouts.datosParaTransferir(payeeId, quien);
    } catch (e) {
      if (e instanceof SinCuentaDeCobroError) throw new NotFoundException(e.message);
      throw e;
    }
  }

  /** «Ya le transferí»: salda todo lo que esa persona tenía pendiente. */
  @Post(':payeeId/pay')
  @HttpCode(200)
  async pagar(@Param('payeeId') payeeId: string, @Body() cuerpo: unknown) {
    this.validarId(payeeId);
    const c = this.parsear(cuerpoDePago, cuerpo);

    try {
      return await this.payouts.pagar(payeeId, c.method, c.updatedBy, {
        reference: c.reference,
        notes: c.notes,
      });
    } catch (e) {
      if (e instanceof SinCuentaDeCobroError) throw new NotFoundException(e.message);
      if (e instanceof NadaQuePagarError) throw new BadRequestException(e.message);
      // El saldo cambió entre que se pintó y se pulsó: que lo vuelva a mirar.
      if (e instanceof ImporteNoCuadraError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  @Post(':payeeId/account/verify')
  @HttpCode(200)
  async verificar(@Param('payeeId') payeeId: string, @Body() cuerpo: unknown) {
    this.validarId(payeeId);
    const c = this.parsear(cuerpoDeEstado, cuerpo);
    return this.payouts.verificarCuenta(payeeId, c.updatedBy);
  }

  @Post(':payeeId/account/reject')
  @HttpCode(200)
  async rechazar(@Param('payeeId') payeeId: string, @Body() cuerpo: unknown) {
    this.validarId(payeeId);
    const c = this.parsear(cuerpoDeEstado, cuerpo);
    if (!c.motivo) throw new BadRequestException('Hace falta el motivo: sin él, nadie sabe qué arreglar.');
    return this.payouts.rechazarCuenta(payeeId, c.motivo, c.updatedBy);
  }

  // ── Interno ───────────────────────────────────────────────────────────────

  private validarId(payeeId: string): void {
    if (!uuid.safeParse(payeeId).success) {
      throw new BadRequestException('El identificador de la persona tiene que ser un UUID.');
    }
  }

  private parsear<T extends z.ZodTypeAny>(esquema: T, cuerpo: unknown): z.infer<T> {
    const r = esquema.safeParse(cuerpo);
    if (!r.success) {
      throw new BadRequestException(
        r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    return r.data;
  }
}
