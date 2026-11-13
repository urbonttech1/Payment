/**
 * Autoriza la cuenta de Square de URBONT para el Tap to Pay. Se ejecuta UNA vez.
 *
 * El SDK móvil de Square no usa el token del servidor: necesita un token OAuth con
 * permisos de cobro, y ese sale del *refresh token* de esta autorización. En el
 * flujo con secreto de aplicación el refresh token ni cambia ni caduca, así que se
 * guarda una vez en el panel (Pagos → Configuración → Square) y no se repite.
 *
 * Dos pasos:
 *
 *   1. Sin argumentos: imprime la URL de autorización. Se abre con la sesión del
 *      VENDEDOR de URBONT, se acepta, y Square redirige a una dirección: se copia
 *      esa URL entera (aunque la página no cargue).
 *
 *        SQUARE_APPLICATION_ID=sq0idp-… npx tsx scripts/square-oauth.ts
 *
 *   2. Con esa URL (o sólo el código) como argumento: la canjea e imprime el
 *      refresh token para pegarlo en el panel.
 *
 *        SQUARE_APPLICATION_ID=… SQUARE_APPLICATION_SECRET=… \
 *          npx tsx scripts/square-oauth.ts 'https://…?code=sq0cgb-…'
 *
 * Variables: SQUARE_APPLICATION_ID, SQUARE_APPLICATION_SECRET (sólo en el paso 2),
 * SQUARE_ENVIRONMENT (`sandbox` o `production`; vacío = production) y, si la
 * aplicación tiene una redirección registrada, SQUARE_OAUTH_REDIRECT_URL.
 *
 * Lo que imprime en el paso 2 es una credencial: se copia al panel y no se guarda
 * en ningún archivo ni se pega en un chat.
 */

import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { SquareClient, SquareEnvironment } from 'square';
import { codigoDeLaRedireccion, urlDeAutorizacion } from '../src/providers/square/square.oauth';

function falta(nombre: string): never {
  console.error(`Falta ${nombre}.`);
  process.exit(1);
}

async function main(): Promise<void> {
  const applicationId = process.env.SQUARE_APPLICATION_ID || falta('SQUARE_APPLICATION_ID');
  const environment = process.env.SQUARE_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production';
  const redirectUrl = process.env.SQUARE_OAUTH_REDIRECT_URL || undefined;
  const pegado = process.argv[2];

  if (!pegado) {
    console.log(`Entorno: ${environment}\n`);
    console.log('1. Abre esta URL con la sesión del vendedor de URBONT y acepta:\n');
    console.log(`   ${urlDeAutorizacion({ applicationId, environment, state: randomBytes(12).toString('hex'), redirectUrl })}\n`);
    console.log('2. Square te redirigirá a una dirección. Copia esa URL entera (aunque la página no cargue) y ejecuta:\n');
    console.log("   npx tsx scripts/square-oauth.ts '<la URL copiada>'");
    return;
  }

  const applicationSecret = process.env.SQUARE_APPLICATION_SECRET || falta('SQUARE_APPLICATION_SECRET');
  const { code } = codigoDeLaRedireccion(pegado);

  const square = new SquareClient({
    environment: environment === 'sandbox' ? SquareEnvironment.Sandbox : SquareEnvironment.Production,
  });
  const r = await square.oAuth.obtainToken({
    clientId: applicationId,
    clientSecret: applicationSecret,
    grantType: 'authorization_code',
    code,
    ...(redirectUrl ? { redirectUri: redirectUrl } : {}),
  });

  if (!r.refreshToken) {
    console.error('Square no devolvió un refresh token. ¿El código ya se usó? Cada código vale una sola vez.');
    process.exit(1);
  }

  console.log('Autorizado. Pega estos tres valores en el panel (Pagos → Configuración → Square):\n');
  console.log(`  Application ID : ${applicationId}`);
  console.log(`  Secreto        : (el SQUARE_APPLICATION_SECRET que acabas de usar)`);
  console.log(`  Refresh token  : ${r.refreshToken}\n`);
  console.log(`Cuenta autorizada: ${r.merchantId ?? 'desconocida'}. Comprueba que es la de URBONT.`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
