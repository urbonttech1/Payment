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
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { ProviderRegistry } from '../providers/provider.registry';
import { PreferredCardsRepository } from './preferred-cards.repository';
import { ErroresDePagoFilter } from './errores.filter';
import { FirmaGuard } from './firma.guard';

const cuerpoDePreferida = z.object({ cardRef: z.string().min(1).max(200) });

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
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly preferidas: PreferredCardsRepository,
  ) {}

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

  /**
   * Las tarjetas de un pagador, buscándolo por el id de URBONT.
   *
   * Va antes que `:customerRef` en el orden de rutas a propósito: si estuviera
   * después, `by-payer` entraría como si fuera una referencia de cliente.
   *
   * Devuelve lista vacía cuando el pagador no tiene cliente en el procesador.
   * Que alguien no tenga tarjetas no es un error, y tratarlo como tal haría que
   * la cartera de un pasajero nuevo pareciera rota.
   */
  @Get('by-payer/:payerId')
  async porPagador(@Param('payerId') payerId: string) {
    const provider = this.registry.paraCobroNuevo(['savedCards']);
    if (!provider.findCustomer) return [];

    const customerRef = await provider.findCustomer(payerId);
    if (!customerRef) return [];

    const tarjetas = await provider.listCards(customerRef);
    if (tarjetas.length === 0) return [];

    // Cuál es la principal lo decide URBONT, no el procesador. Si no hay
    // preferencia guardada manda la primera, que es el comportamiento de antes
    // y el único posible cuando sólo hay una.
    const preferida = await this.preferidas.obtener(payerId, provider.name);
    return tarjetas.map((t) => ({
      ...t,
      // Hace falta para cobrar la tarjeta guardada: Square exige el cliente
      // junto al `ccof:`. Sin esto el cobro no sabe a quién pertenece.
      customerRef,
      isDefault: preferida ? t.providerRef === preferida : t === tarjetas[0],
    }));
  }

  /**
   * Fija con qué tarjeta se le cobra a este pagador.
   *
   * Se comprueba que la tarjeta sea SUYA antes de guardarla: sin eso, mandar
   * el identificador de la tarjeta de otro bastaría para que le cobraran a él.
   */
  @Post('by-payer/:payerId/default')
  @HttpCode(200)
  async fijarPreferida(@Param('payerId') payerId: string, @Body() cuerpo: unknown) {
    const r = cuerpoDePreferida.safeParse(cuerpo);
    if (!r.success) throw new BadRequestException('Falta la tarjeta (cardRef).');

    const provider = this.registry.paraCobroNuevo(['savedCards']);
    if (!provider.findCustomer) throw new BadRequestException('Esta pasarela no sabe buscar tarjetas por pagador.');

    const customerRef = await provider.findCustomer(payerId);
    const suyas = customerRef ? await provider.listCards(customerRef) : [];
    if (!suyas.some((t) => t.providerRef === r.data.cardRef)) {
      throw new NotFoundException('Esa tarjeta no es de este pagador.');
    }

    await this.preferidas.fijar(payerId, provider.name, r.data.cardRef);
    return { payerId, provider: provider.name, cardRef: r.data.cardRef };
  }

  @Get(':customerRef')
  async listar(@Param('customerRef') customerRef: string) {
    const provider = this.registry.paraCobroNuevo(['savedCards']);
    return provider.listCards(customerRef);
  }
}
