/**
 * La autorización OAuth de la cuenta de Square. Se hace una sola vez.
 *
 * El SDK móvil de Square no se autoriza con el token del servidor: necesita un
 * token OAuth con permisos de cobro. Ese token sale del *refresh token* que
 * resulta de autorizar la cuenta una vez, y el refresh token —en el flujo con
 * secreto de aplicación— ni cambia ni caduca. Lo que hay aquí es la parte pura de
 * esa primera autorización; `scripts/square-oauth.ts` la ejecuta.
 */

/**
 * Los permisos que se piden al autorizar: el TECHO de lo que el token del teléfono
 * podrá pedir después, porque `scopes` en `ObtainToken` sólo puede ser un
 * subconjunto de lo autorizado.
 *
 * Los tres primeros son los que usa el dispositivo (ver `PERMISOS_DEL_DISPOSITIVO`
 * en el adaptador). `PAYMENTS_READ` se deja para poder leer un pago al adoptarlo
 * desde un token de aplicación, y NADA más: ni empleados, ni comisiones a terceros,
 * ni clientes, ni nada de bancos.
 */
export const PERMISOS_DE_AUTORIZACION = [
  'MERCHANT_PROFILE_READ',
  'PAYMENTS_WRITE',
  'PAYMENTS_WRITE_IN_PERSON',
  'PAYMENTS_READ',
] as const;

export interface PeticionDeAutorizacion {
  applicationId: string;
  environment: 'sandbox' | 'production';
  /** Un valor al azar que Square devuelve intacto, para comprobar que la respuesta es de esta petición. */
  state: string;
  /** Sólo si la aplicación tiene una redirección registrada en el panel de Square. */
  redirectUrl?: string;
}

const HOST = {
  production: 'https://connect.squareup.com',
  sandbox: 'https://connect.squareupsandbox.com',
} as const;

/** La URL que hay que abrir con la sesión del vendedor de URBONT para autorizar la aplicación. */
export function urlDeAutorizacion(p: PeticionDeAutorizacion): string {
  const q = new URLSearchParams({
    client_id: p.applicationId,
    scope: PERMISOS_DE_AUTORIZACION.join(' '),
    // `session=false` obliga a iniciar sesión en Square aunque ya haya una abierta:
    // con varias cuentas, autorizar la equivocada es un error que no se ve.
    session: 'false',
    state: p.state,
    ...(p.redirectUrl ? { redirect_uri: p.redirectUrl } : {}),
  });
  return `${HOST[p.environment]}/oauth2/authorize?${q.toString()}`;
}

/**
 * El código de autorización, sacado de lo que se copia tras aceptar: la URL de
 * redirección completa o el código suelto.
 *
 * Si Square devolvió un error (`access_denied`…) se dice tal cual, en vez de dejar
 * que se confunda con un código que no existe.
 */
export function codigoDeLaRedireccion(pegado: string): { code: string; state: string | null } {
  const texto = pegado.trim();
  if (!/^https?:\/\//i.test(texto)) {
    if (!texto) throw new Error('No hay ningún código: pega la URL a la que Square redirigió o el código.');
    return { code: texto, state: null };
  }

  const q = new URL(texto).searchParams;
  const error = q.get('error');
  if (error) {
    throw new Error(`Square no autorizó la aplicación (${error}): ${q.get('error_description') ?? 'sin más detalle'}.`);
  }
  const code = q.get('code');
  if (!code) throw new Error('La URL no trae ningún código de autorización (falta ?code=…).');
  return { code, state: q.get('state') };
}
