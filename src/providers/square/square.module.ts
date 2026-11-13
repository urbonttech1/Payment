/**
 * El módulo del adaptador de Square.
 *
 * Igual que el de Stripe: sin credenciales no se monta y el servicio arranca
 * lo mismo. En el registro aparecerá que Square no está disponible, en vez de
 * fallar al primer cobro con un error de autenticación.
 *
 * Square necesita **dos** cosas y no una: el token y la localización que cobra.
 * Sin localización, Square rechaza cada cobro, así que un token suelto no basta
 * para montarlo y aquí se dice en el arranque.
 */

import { Module } from '@nestjs/common';
import { SquareClient, SquareEnvironment } from 'square';
import { CONFIG, type Config } from '../../config/config';
import { urlDeWebhook } from '../../config/enlacesWebhook';
import { SquareProvider } from './square.provider';

export const SQUARE_PROVIDER = Symbol('SQUARE_PROVIDER');

export type ConfigDeSquare = Pick<
  Config,
  | 'SQUARE_ACCESS_TOKEN'
  | 'SQUARE_LOCATION_ID'
  | 'SQUARE_ENVIRONMENT'
  | 'SQUARE_WEBHOOK_SIGNATURE_KEY'
  | 'SQUARE_WEBHOOK_NOTIFICATION_URL'
  | 'SQUARE_APPLICATION_ID'
  | 'SQUARE_APPLICATION_SECRET'
  | 'SQUARE_REFRESH_TOKEN'
>;

/** El adaptador, o `null` si esta instalación no tiene credenciales de Square. */
export function crearSquareProvider(config: ConfigDeSquare): SquareProvider | null {
  if (!config.SQUARE_ACCESS_TOKEN || !config.SQUARE_LOCATION_ID) return null;

  const square = new SquareClient({
    token: config.SQUARE_ACCESS_TOKEN,
    // El token de sandbox y el de producción son distintos y no se distinguen
    // mirándolos: el entorno es explícito a propósito. Un token de sandbox
    // apuntando a producción falla en el `ping`, antes de guardarse.
    environment:
      config.SQUARE_ENVIRONMENT === 'sandbox' ? SquareEnvironment.Sandbox : SquareEnvironment.Production,
    // Sin `version`, el SDK usa la que trae fijada su propia versión, que es la
    // que sus tipos describen. Escribir otra a mano desajusta tipos y
    // respuestas, y es un desajuste que sólo se nota en producción.
    timeoutInSeconds: 20,
    maxRetries: 2,
  });

  // Tap to Pay: los tres o nada. Con dos de tres no se puede pedir el token del
  // teléfono, y anunciar la capacidad haría que el registro eligiera Square para
  // un cobro que acabaría fallando con el chofer delante. Una cadena vacía
  // —ECS inyecta `""` si la variable no está puesta— cuenta como ausente.
  const oauth =
    config.SQUARE_APPLICATION_ID && config.SQUARE_APPLICATION_SECRET && config.SQUARE_REFRESH_TOKEN
      ? {
          applicationId: config.SQUARE_APPLICATION_ID,
          applicationSecret: config.SQUARE_APPLICATION_SECRET,
          refreshToken: config.SQUARE_REFRESH_TOKEN,
          // Un cliente aparte, SIN el token del servidor: ObtainToken se
          // autentica con el secreto de la aplicación en el cuerpo.
          client: new SquareClient({
            environment:
              config.SQUARE_ENVIRONMENT === 'sandbox' ? SquareEnvironment.Sandbox : SquareEnvironment.Production,
            timeoutInSeconds: 20,
            maxRetries: 2,
          }),
        }
      : undefined;

  return new SquareProvider(
    square,
    {
      locationId: config.SQUARE_LOCATION_ID,
      webhookSignatureKey: config.SQUARE_WEBHOOK_SIGNATURE_KEY,
      webhookNotificationUrl: config.SQUARE_WEBHOOK_NOTIFICATION_URL,
    },
    oauth,
  );
}

@Module({
  providers: [{
    provide: SQUARE_PROVIDER,
    inject: [CONFIG],
    useFactory: (config: Config) => crearSquareProvider({
      ...config,
      // Si el entorno no fijó la URL, se comprueba la misma que enseña el panel.
      SQUARE_WEBHOOK_NOTIFICATION_URL:
        config.SQUARE_WEBHOOK_NOTIFICATION_URL ?? urlDeWebhook(config.PAYMENTS_PUBLIC_URL, 'square'),
    }),
  }],
  exports: [SQUARE_PROVIDER],
})
export class SquareModule {}
