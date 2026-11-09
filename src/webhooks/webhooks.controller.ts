/**
 * La puerta de los procesadores.
 *
 * A diferencia de `/internal/*`, esto NO lleva la firma de URBONT: lo que
 * autentica un aviso es la firma del procesador, y la comprueba su propio
 * adaptador contra el cuerpo crudo. Por eso es la única ruta del servicio que
 * puede llamar alguien de fuera.
 *
 * Qué se responde, y por qué importa:
 *
 *  · **400 si la firma no cuadra.** Stripe no reintenta un 400, y hace bien:
 *    si la firma está mal, reintentarla la seguirá teniendo mal.
 *  · **500 si no se pudo guardar el aviso.** Eso sí conviene que lo reintente:
 *    es nuestra base la que falló, no su aviso.
 *  · **200 si se guardó, aunque procesarlo haya fallado.** El aviso ya es
 *    nuestro y lo reintentamos por nuestra cuenta. Pedirle a Stripe que insista
 *    con algo que ya tenemos sólo duplica trabajo, y Stripe se rinde a los tres
 *    días mientras nuestra cola no se rinde nunca.
 */

import {
  BadRequestException,
  Controller,
  HttpCode,
  Param,
  Post,
  Req,
  UseFilters,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ErroresDePagoFilter } from '../internal/errores.filter';
import { FirmaDeWebhookInvalidaError, type ProviderName } from '../providers/provider.port';
import { WebhooksService, type ResultadoDeAviso } from './webhooks.service';

const PROCESADORES = new Set<ProviderName>(['stripe', 'square', 'adyen', 'finix', 'paypal', 'ach']);

@Controller('webhooks')
@UseFilters(ErroresDePagoFilter)
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post(':provider')
  @HttpCode(200)
  async recibir(
    @Param('provider') provider: string,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<ResultadoDeAviso> {
    if (!PROCESADORES.has(provider as ProviderName)) {
      throw new BadRequestException({ error: 'UNKNOWN_PROVIDER' });
    }
    if (!req.rawBody) {
      // Sin cuerpo crudo no hay firma que comprobar, y sin firma no se cree
      // nada: el cuerpo ya parseado y vuelto a serializar no vale.
      throw new BadRequestException({ error: 'MISSING_RAW_BODY' });
    }

    try {
      return await this.webhooks.recibir(provider as ProviderName, {
        raw: req.rawBody,
        headers: req.headers,
      });
    } catch (e) {
      // SÓLO la firma se convierte en 400. Todo lo demás —la base caída, el
      // procesador sin montar— sube al filtro y sale como 5xx, que es lo que
      // hace que el procesador reintente. Devolver 400 cuando el fallo es
      // nuestro es perder el aviso para siempre.
      if (e instanceof FirmaDeWebhookInvalidaError) {
        throw new BadRequestException({ error: 'INVALID_SIGNATURE', detalle: e.message });
      }
      throw e;
    }
  }
}
