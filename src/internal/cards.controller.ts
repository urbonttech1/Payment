/**
 * Las tarjetas guardadas del pasajero.
 *
 * Existe porque los dos procesadores guardan una tarjeta al revés el uno del
 * otro, y la app no puede saber cuál le toca: Stripe crea un `SetupIntent` en
 * el servidor y la app lo confirma; Square exige que la app tokenice primero y
 * el servidor guarda ese token. El contrato devuelve una unión que dice en cuál
 * de los dos sitios terminó, y quien llama actúa en consecuencia.
 *
 * `GET /capabilities` existe por lo mismo: **la app tiene que saber qué
 * procesador le toca antes de pintar el formulario.** Sin eso tendría que
 * adivinar si tokeniza o si espera un `clientSecret`, y adivinar mal significa
 * un formulario que no cobra.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { ProviderRegistry } from '../providers/provider.registry';
import { ErroresDePagoFilter } from './errores.filter';
import { FirmaGuard } from './firma.guard';

const cuerpoDeGuardado = z.object({
  payerId: z.string().min(1).max(100),
  idempotencyKey: z.string().min(8).max(200),
  /** El token que la app generó. Square lo exige; Stripe lo ignora. */
  cardToken: z.string().max(500).optional(),
  customerRef: z.string().max(200).optional(),
});

@Controller('internal/cards')
@UseGuards(FirmaGuard)
@UseFilters(ErroresDePagoFilter)
export class CardsController {
  constructor(private readonly registry: ProviderRegistry) {}

  /**
   * Qué tiene que hacer la app para guardar una tarjeta.
   *
   * Se responde con el procesador que de verdad atendería la operación, no con
   * el que esté por defecto: si el de por defecto no sabe guardar tarjetas, el
   * registro elige otro, y la app tiene que preparar el formulario de ése.
   */
  @Get('capabilities')
  capacidades() {
    const p = this.registry.paraCobroNuevo(['savedCards']);
    return {
      provider: p.name,
      // `tokeniza-en-cliente` es lo que la app necesita saber: si es true,
      // monta el SDK del procesador y manda un token; si no, espera un secreto.
      tokenizaEnCliente: p.name !== 'stripe',
      capabilities: p.capabilities,
    };
  }

  @Post()
  async guardar(@Body() cuerpo: unknown) {
    const r = cuerpoDeGuardado.safeParse(cuerpo);
    if (!r.success) {
      throw new BadRequestException(
        r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }

    const provider = this.registry.paraCobroNuevo(['savedCards']);
    const guardado = await provider.saveCard({
      idempotencyKey: r.data.idempotencyKey,
      payerId: r.data.payerId,
      customerRef: r.data.customerRef,
      cardToken: r.data.cardToken,
    });

    // Se devuelve el modo tal cual: quien llama tiene que saber si la tarjeta
    // ya está guardada o si falta que la app confirme. Aplanarlo aquí sería
    // volver a esconder la diferencia que el contrato existe para enseñar.
    return { provider: provider.name, ...guardado };
  }

  @Get(':customerRef')
  async listar(@Param('customerRef') customerRef: string) {
    const provider = this.registry.paraCobroNuevo(['savedCards']);
    return provider.listCards(customerRef);
  }
}
