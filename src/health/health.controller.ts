/**
 * Sondas del servicio.
 *
 * `/healthz` es la que miran el balanceador y ECS: comprueba la base de datos,
 * porque un servicio de pagos que no puede escribir su libro no está sano
 * aunque responda. `/readyz` sólo dice que el proceso está en pie.
 */

import { Controller, Get, Inject, HttpException, HttpStatus } from '@nestjs/common';
import type { Pool } from 'pg';
import { POOL } from '../db/pool';

@Controller()
export class HealthController {
  private readonly arrancadoEn = Date.now();

  constructor(@Inject(POOL) private readonly pool: Pool) {}

  /**
   * Con un límite propio, no el del pool.
   *
   * Cuando la base cae, una consulta sobre una conexión ya abierta se queda
   * esperando a que el TCP se rinda, que puede ser más de un minuto. La sonda
   * entonces no responde «mal», sino que no responde: el balanceador acaba
   * sacando la tarea igual, pero sin decir por qué y mucho más tarde.
   */
  private async sondaDeBase(limiteMs = 2_000): Promise<void> {
    let temporizador: NodeJS.Timeout | undefined;
    const limite = new Promise<never>((_, rechazar) => {
      temporizador = setTimeout(
        () => rechazar(new Error(`la base no respondió en ${limiteMs} ms`)),
        limiteMs,
      );
    });
    try {
      await Promise.race([this.pool.query('SELECT 1'), limite]);
    } finally {
      if (temporizador) clearTimeout(temporizador);
    }
  }

  @Get('healthz')
  async healthz() {
    const inicio = Date.now();
    try {
      await this.sondaDeBase();
    } catch (e) {
      throw new HttpException(
        {
          status: 'degradado',
          checks: { db: 'caída' },
          detalle: (e instanceof Error ? e.message : String(e)) || 'sin detalle del controlador',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return {
      status: 'ok',
      service: 'urbont-payments',
      checks: { db: 'ok' },
      uptimeSec: Math.round((Date.now() - this.arrancadoEn) / 1000),
      latencyMs: Date.now() - inicio,
      ts: new Date().toISOString(),
    };
  }

  @Get('readyz')
  readyz() {
    return { status: 'ok', ts: new Date().toISOString() };
  }
}
