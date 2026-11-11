import { describe, expect, it } from 'vitest';
import { enlacesDeWebhook, urlDeWebhook } from './enlacesWebhook';

describe('enlaces de webhook', () => {
  it('quita la barra final de la dirección pública', () => {
    expect(urlDeWebhook('https://payments.urbont.com/', 'stripe')).toBe(
      'https://payments.urbont.com/webhooks/stripe',
    );
  });

  // Stripe usa esta ruta para dos endpoints —la cuenta y Connect—, pero la URL
  // es la misma: enseñarla dos veces parece un fallo de la pantalla. Lo que hay
  // que saber va en la nota.
  it('STRIPE ENSEÑA UN SOLO ENLACE, Y LA NOTA EXPLICA LOS DOS ENDPOINTS', () => {
    const enlaces = enlacesDeWebhook('https://payments.urbont.com', 'stripe');
    expect(enlaces).toHaveLength(1);
    expect(enlaces[0].url).toBe('https://payments.urbont.com/webhooks/stripe');
    expect(enlaces[0].nota).toMatch(/Connect/);
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
