/**
 * El guardia de `/internal/*`.
 *
 * Es lo único que separa el dinero de cualquiera que conozca el host: el
 * balanceador es público y la regla por host hace el servicio alcanzable, así
 * que la red no protege nada por sí sola.
 *
 * Trabaja sobre `req.rawBody`, que existe porque `main.ts` arranca Nest con
 * `rawBody: true`. Firmar el cuerpo ya parseado y vuelto a serializar no sirve:
 * el orden de las claves y los espacios cambian, y la firma dejaría de cuadrar
 * por motivos que no tienen nada que ver con la seguridad.
 */

import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { RawBodyRequest } from '@nestjs/common';
import { CONFIG, type Config } from '../config/config';
import { CABECERA_FIRMA, CABECERA_TS, verificar } from './firma';

function unaCabecera(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

@Injectable()
export class FirmaGuard implements CanActivate {
  private readonly log = new Logger(FirmaGuard.name);

  constructor(@Inject(CONFIG) private readonly config: Config) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<RawBodyRequest<Request>>();

    const veredicto = verificar(
      {
        metodo: req.method,
        // `originalUrl` incluye la query. La ruta entra en la firma para que una
        // firma válida de `/capture` no sirva tal cual para `/refund`.
        ruta: req.originalUrl,
        cuerpo: req.rawBody ?? '',
        ts: Number(unaCabecera(req.headers[CABECERA_TS])),
      },
      this.config.SERVICE_SHARED_SECRET,
      unaCabecera(req.headers[CABECERA_FIRMA]),
    );

    if (!veredicto.ok) {
      // El motivo, al registro; a quien llama, nada. Decirle por qué falló su
      // firma es ayudarle a acertar en el siguiente intento.
      this.log.warn(
        `[FIRMA] Rechazada ${req.method} ${req.originalUrl} desde ${req.ip ?? 'origen desconocido'}: ${veredicto.motivo}`,
      );
      throw new UnauthorizedException('No autorizado');
    }

    return true;
  }
}
