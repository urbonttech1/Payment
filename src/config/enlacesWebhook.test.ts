import { describe, expect, it } from 'vitest';
import { enlacesDeWebhook, urlDeWebhook } from './enlacesWebhook';

describe('enlaces de webhook', () => {
  it('quita la barra final de la dirección pública', () => {
    expect(urlDeWebhook('https://payments.urbont.com/', 'stripe')).toBe(
      'https://payments.urbont.com/webhooks/stripe',
    );
  });

  it('Stripe tiene dos enlaces y los dos apuntan a la misma ruta', () => {
    const enlaces = enlacesDeWebhook('https://payments.urbont.com', 'stripe');
    expect(enlaces.map((e) => e.id)).toEqual(['cuenta', 'connect']);
    expect(new Set(enlaces.map((e) => e.url)).size).toBe(1);
    expect(enlaces[0].url).toBe('https://payments.urbont.com/webhooks/stripe');
  });

  it('Square enseña la URL que de verdad se verifica, si el entorno fijó otra', () => {
    const enlaces = enlacesDeWebhook(
      'https://payments.urbont.com',
      'square',
      'https://staging.example/webhooks/square',
    );
    expect(enlaces).toHaveLength(1);
    expect(enlaces[0].url).toBe('https://staging.example/webhooks/square');
  });
});
