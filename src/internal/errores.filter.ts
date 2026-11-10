/**
 * Traduce los errores del dominio a códigos HTTP.
 *
 * Importa más de lo que parece: al otro lado, `urbont-api` decide con el código
 * si **se cae al camino viejo o no**. Un 502 significa «el procesador falló,
 * inténtalo por Stripe directo»; un 402 significa «la tarjeta dijo no», y
 * reintentarlo por otro camino es pedirle dos veces el no al mismo banco.
 *
 * Por eso ningún error acaba aquí como 500 por descarte sin que quede dicho en
 * el registro: un 500 inesperado hace que el cobro se vaya por el camino viejo,
 * y eso hay que poder verlo.
 */

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { PagoRechazadoError, ProcesadorFalloError } from '../providers/provider.port';
import { ProviderNotAvailableError } from '../providers/provider.registry';
import {
  EstadoInesperadoError,
  TransaccionNoEncontradaError,
} from '../payments/payments.service';
import { RepartoImposibleError } from '../splits/reparto';
import { CuentaDeOtraPersonaError } from '../payees/payees.repository';
import { CredencialInvalidaError, SinSoporteError } from '../config/credentials.service';

interface Cuerpo {
  error: string;
  code?: string;
  detalle?: string;
}

@Catch()
export class ErroresDePagoFilter implements ExceptionFilter {
  private readonly log = new Logger(ErroresDePagoFilter.name);

  catch(e: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<{ method: string; originalUrl: string }>();

    const { estado, cuerpo, aviso } = this.traducir(e);
    const linea = `${req.method} ${req.originalUrl} → ${estado} ${cuerpo.error}`;
    if (aviso) this.log.error(`${linea}: ${e instanceof Error ? e.stack : String(e)}`);
    else this.log.warn(`${linea}: ${e instanceof Error ? e.message : String(e)}`);

    res.status(estado).json(cuerpo);
  }

  private traducir(e: unknown): { estado: number; cuerpo: Cuerpo; aviso: boolean } {
    if (e instanceof TransaccionNoEncontradaError) {
      return { estado: HttpStatus.NOT_FOUND, cuerpo: { error: 'CHARGE_NOT_FOUND' }, aviso: false };
    }
    if (e instanceof EstadoInesperadoError) {
      return {
        estado: HttpStatus.CONFLICT,
        cuerpo: { error: 'UNEXPECTED_CHARGE_STATE', detalle: e.detalle },
        aviso: false,
      };
    }
    // Los datos del reparto no cuadran (un impuesto mayor que el cobro, una
    // tasa imposible): es la petición la que está mal, no el cobro.
    if (e instanceof RepartoImposibleError) {
      return {
        estado: HttpStatus.BAD_REQUEST,
        cuerpo: { error: 'INVALID_REQUEST', detalle: e.message },
        aviso: false,
      };
    }
    // La cuenta de cobro que nos pasaron es de otra persona. Hay que corregir
    // el dato de origen, así que se dice con un código que no invita a
    // reintentar y con el detalle suficiente para encontrarlo.
    if (e instanceof CuentaDeOtraPersonaError) {
      return {
        estado: HttpStatus.CONFLICT,
        cuerpo: { error: 'PAYEE_ACCOUNT_TAKEN', detalle: e.message },
        aviso: true,
      };
    }
    // La credencial que pegaron no vale. Es un 422 y no un 500: no hay nada
    // roto, hay que corregir lo que se escribió.
    if (e instanceof CredencialInvalidaError) {
      return {
        estado: HttpStatus.UNPROCESSABLE_ENTITY,
        cuerpo: { error: 'INVALID_CREDENTIALS', detalle: e.message },
        aviso: false,
      };
    }
    if (e instanceof SinSoporteError) {
      return {
        estado: HttpStatus.NOT_IMPLEMENTED,
        cuerpo: { error: 'PROVIDER_NOT_SUPPORTED', detalle: e.message },
        aviso: false,
      };
    }
    if (e instanceof PagoRechazadoError) {
      return {
        estado: HttpStatus.PAYMENT_REQUIRED,
        cuerpo: { error: 'PAYMENT_DECLINED', code: e.codigo, detalle: e.message },
        aviso: false,
      };
    }
    if (e instanceof ProcesadorFalloError) {
      return { estado: HttpStatus.BAD_GATEWAY, cuerpo: { error: 'PROVIDER_FAILED' }, aviso: true };
    }
    if (e instanceof ProviderNotAvailableError) {
      return {
        estado: HttpStatus.SERVICE_UNAVAILABLE,
        cuerpo: { error: 'PROVIDER_UNAVAILABLE', detalle: e.detail },
        aviso: true,
      };
    }
    if (e instanceof HttpException) {
      const r = e.getResponse();
      const cuerpo: Cuerpo =
        typeof r === 'string'
          ? { error: r }
          : { error: 'BAD_REQUEST', ...(r as Record<string, unknown>) };
      return { estado: e.getStatus(), cuerpo, aviso: e.getStatus() >= 500 };
    }
    return {
      estado: HttpStatus.INTERNAL_SERVER_ERROR,
      cuerpo: { error: 'INTERNAL' },
      aviso: true,
    };
  }
}
