/**
 * El enlace que hay que pegar en cada pasarela.
 *
 * El servicio recibe los avisos en `POST /webhooks/<procesador>`. Cada
 * pasarela tiene el suyo, y Stripe tiene dos: el de la cuenta de Urbont y el
 * de Connect (las cuentas de los choferes). Los dos llegan a la misma ruta —
 * el adaptador prueba los dos secretos— pero en el panel de Stripe son dos
 * endpoints distintos, y cada uno se pega por separado.
 *
 * Square firma incluyendo la URL, así que la que se enseña tiene que ser,
 * carácter por carácter, la que el adaptador comprueba.
 */

export interface EnlaceWebhook {
  id: string;
  etiqueta: string;
  url: string;
  nota: string;
}

/** `https://host/webhooks/stripe`, sin barras de más. */
export function urlDeWebhook(basePublica: string, provider: string): string {
  const base = basePublica.replace(/\/+$/, '');
  return `${base}/webhooks/${provider}`;
}

/**
 * Lo que el panel enseña para esa pasarela.
 *
 * `urlVerificada` es la que de verdad comprueba el adaptador. En Square puede
 * diferir de la pública si el entorno fijó `SQUARE_WEBHOOK_NOTIFICATION_URL`.
 */
export function enlacesDeWebhook(
  basePublica: string,
  provider: string,
  urlVerificada?: string,
): EnlaceWebhook[] {
  const url = urlVerificada || urlDeWebhook(basePublica, provider);

  if (provider === 'stripe') {
    // Un solo enlace, aunque en Stripe se use dos veces. Enseñar la misma URL
    // repetida parece un fallo de la pantalla, y lo que de verdad hay que
    // saber no es que hay dos líneas: es que hay dos endpoints con secretos
    // distintos, y eso cabe en la nota.
    return [
      {
        id: 'stripe',
        etiqueta: 'Webhook',
        url,
        nota:
          'En Stripe se pega DOS veces, en dos endpoints distintos: el de la cuenta de Urbont y ' +
          'el de Connect (las cuentas de los choferes). Cada uno trae su propio secreto, y los dos ' +
          'van arriba, en las credenciales.',
      },
    ];
  }

  if (provider === 'square') {
    return [
      {
        id: 'entrega',
        etiqueta: 'Webhook',
        url,
        nota: 'Pégala tal cual en Square. La firma incluye esta URL: un carácter de diferencia hace que ningún aviso cuadre.',
      },
    ];
  }

  return [
    {
      id: 'aviso',
      etiqueta: 'Webhook',
      url,
      nota: 'Pégala en el panel de esa pasarela.',
    },
  ];
}
