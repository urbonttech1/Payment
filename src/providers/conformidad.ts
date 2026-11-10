/**
 * Las pruebas que **todo** adaptador tiene que pasar.
 *
 * El contrato (`provider.port.ts`) dice qué métodos existen; esto dice cómo
 * tienen que portarse. Es la diferencia entre «añadir un procesador es escribir
 * un módulo» y que de verdad lo sea: quien escriba el de Square, Adyen o Finix
 * implementa el arnés de abajo, llama a `pruebasDeConformidad` y sabe, antes de
 * tocar producción, si su adaptador cumple las reglas de URBONT.
 *
 * Las reglas no son teóricas. Cada una está aquí porque su incumplimiento ya
 * costó dinero en este proyecto:
 *
 *  · **Un cobro no reparte en origen.** El adaptador de Stripe mandaba
 *    `transfer_data` en el cobro y además se transfería al chofer al terminar:
 *    el chofer cobraba dos veces y la segunda salía del saldo de URBONT. En un
 *    viaje de $110, $89 perdidos (hallazgo 04 de la auditoría).
 *  · **Todo lo que mueve dinero lleva clave de idempotencia.** La comisión del
 *    valet era la única transferencia de nueve sin clave: un reintento la
 *    pagaba dos veces.
 *  · **Crear un cobro no es cobrarlo.** Un cobro que el banco deja pendiente de
 *    autenticación no puede volver como «capturado»: eso le mostró a un chofer
 *    una propina de $10 que ningún pasajero pagó.
 *
 * No se llama a ninguna API de verdad: el arnés monta el adaptador con el
 * transporte falso que su autor quiera. Lo que se comprueba es el
 * comportamiento observable a través del contrato, no la forma de las llamadas
 * de cada procesador.
 */

import { describe, expect, it } from 'vitest';
import {
  PagoRechazadoError,
  ProcesadorFalloError,
  type AuthorizeCommand,
  type PaymentProvider,
} from './provider.port';

/** Lo que tiene que proveer quien escriba un adaptador nuevo. */
export interface ArnesDeConformidad {
  /** Para los nombres de las pruebas: 'Square', 'Adyen'… */
  nombre: string;

  /** Monta el adaptador con su transporte falso, listo para una llamada feliz. */
  montar(): PaymentProvider;

  /**
   * Lo que el adaptador le pidió al procesador en la última llamada, **tal
   * cual**: cuerpo y opciones, sin interpretar.
   *
   * Se serializa para buscar dentro, así que puede ser cualquier forma. Lo que
   * no puede es omitir nada: si el adaptador manda la clave de idempotencia en
   * una cabecera, la cabecera tiene que estar aquí.
   */
  ultimaPeticion(): unknown;

  /**
   * Lo que ese procesador exige para poder crear un cobro **siquiera**.
   *
   * No todos empiezan igual: Stripe crea el cobro y la app lo confirma después
   * con el `clientSecret`, mientras Square exige que la app tokenice la tarjeta
   * primero y manda ese token en la creación. El arnés añade aquí lo que su
   * procesador necesita (`cardRef`, por ejemplo) y las reglas de abajo se
   * comprueban igual: lo que no se admite es relajar una regla, no decir con
   * qué datos se cobra.
   */
  extras?: Partial<AuthorizeCommand>;

  /** Monta el adaptador de forma que la siguiente llamada la rechace la tarjeta. */
  montarConRechazo(): PaymentProvider;

  /** Monta el adaptador de forma que la siguiente llamada falle por el procesador. */
  montarConFalloDelProcesador(): PaymentProvider;
}

const COBRO: AuthorizeCommand = {
  idempotencyKey: 'ride_conformidad_authorize',
  kind: 'ride',
  amount: 11000,
  currency: 'USD',
  hold: true,
  taxAmount: 715,
  reference: { rideId: 'ride-conformidad', payerId: 'pax-conformidad' },
};

/**
 * Palabras que, en el cobro, delatan un reparto en origen.
 *
 * Es una heurística sobre el texto de la petición, y a propósito: lo que se
 * busca no es la forma exacta de un procesador concreto, es que a nadie se le
 * ocurra mandar el destino del dinero dentro del cobro. Si un procesador llama
 * a eso de otra manera, se añade aquí.
 */
const PALABRAS_DE_REPARTO = [
  'transfer_data',
  'application_fee',
  'additional_recipients',
  'app_fee',
  'split',
  'destination',
  'on_behalf_of',
  'platform_fee',
];

function texto(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x)) ?? '';
  } catch {
    return String(v);
  }
}

/**
 * La palabra de reparto que aparece en la petición, o `null`.
 *
 * Exportada para poder probar que esto de verdad caza lo que dice cazar: una
 * suite de conformidad que pasa siempre es peor que no tener ninguna.
 */
export function mencionaReparto(peticion: unknown): string | null {
  const t = texto(peticion).toLowerCase();
  return PALABRAS_DE_REPARTO.find((palabra) => t.includes(palabra)) ?? null;
}

/** `true` si la clave de idempotencia viaja en la petición. */
export function llevaLaClave(peticion: unknown, clave: string): boolean {
  return texto(peticion).includes(clave);
}

export function pruebasDeConformidad(arnes: ArnesDeConformidad): void {
  const cobro: AuthorizeCommand = { ...COBRO, ...(arnes.extras ?? {}) };

  describe(`${arnes.nombre} · conformidad con el contrato`, () => {
    describe('qué dice que sabe hacer', () => {
      it('se llama como se registra', () => {
        const p = arnes.montar();
        expect(p.name).toBeTruthy();
        expect(p.name).toBe(p.name.toLowerCase());
      });

      // Un procesador que no reparte en la captura y tampoco sabe pagar a
      // terceros no puede pagarle al chofer. Se admite —cobrar ya sirve de
      // algo—, pero **tiene que negarse en voz alta**: una transferencia que no
      // hace nada y tampoco falla deja al chofer esperando un pago que nadie va
      // a mandar, y en el libro el reparto queda como hecho. Es el hallazgo 04
      // otra vez, visto por el otro lado.
      it('O SABE PAGARLE AL CHOFER, O SE NIEGA EN VOZ ALTA', async () => {
        const p = arnes.montar();
        if (p.capabilities.splitAtCapture || p.capabilities.payouts) return;
        await expect(
          p.transfer({
            idempotencyKey: 'k_transfer_conformidad',
            payeeRef: 'payee_conformidad',
            amount: 7400,
            currency: 'USD',
            reference: { rideId: 'ride-conformidad' },
          }),
          'transfer() no falló: un reparto que no va a ocurrir tiene que fallar',
        ).rejects.toThrow();
      });

      it('declara al menos una moneda', () => {
        expect(arnes.montar().capabilities.currencies.length).toBeGreaterThan(0);
      });

      it('lo que dice que sabe hacer, lo tiene implementado', () => {
        const p = arnes.montar();
        if (p.capabilities.increaseAuthorization) expect(typeof p.increaseAuthorization).toBe('function');
      });

      it('y lo que no, no lo anuncia a medias', () => {
        const p = arnes.montar();
        if (!p.capabilities.tapToPay) {
          expect(p.presentCharge).toBeUndefined();
          expect(p.terminalSession).toBeUndefined();
        }
        if (!p.capabilities.increaseAuthorization) expect(p.increaseAuthorization).toBeUndefined();
      });

      // Tap to Pay son DOS mitades y la que se olvida es siempre la misma: el
      // token de sesión. Sin él, el SDK del teléfono no arranca y el cobro
      // presencial no existe, por mucho que `presentCharge` esté escrito.
      it('TAP TO PAY EXIGE EL COBRO Y EL TOKEN DEL LECTOR', () => {
        const p = arnes.montar();
        if (!p.capabilities.tapToPay) return;
        expect(typeof p.presentCharge, 'falta presentCharge').toBe('function');
        expect(typeof p.terminalSession, 'falta terminalSession').toBe('function');
      });
    });

    describe('lo que devuelve', () => {
      it('firma todo con su propio nombre', async () => {
        const p = arnes.montar();
        const a = await p.authorize(cobro);
        expect(a.provider).toBe(p.name);
        expect(a.providerRef).toBeTruthy();
      });

      it('los importes son centavos enteros', async () => {
        const a = await arnes.montar().authorize(cobro);
        expect(Number.isInteger(a.amount)).toBe(true);
      });

      // Crear un cobro no es cobrarlo: una retención no puede volver capturada.
      it('UNA RETENCIÓN NO VUELVE COMO COBRADA', async () => {
        const a = await arnes.montar().authorize({ ...cobro, hold: true });
        expect(['authorized', 'requires_action']).toContain(a.status);
      });

      it('el estado es uno de los del contrato', async () => {
        const a = await arnes.montar().authorize(cobro);
        expect(['requires_action', 'authorized', 'captured', 'failed', 'voided']).toContain(a.status);
      });
    });

    describe('las dos reglas del dinero', () => {
      // El hallazgo 04: el cobro repartía en origen y además se transfería al
      // terminar. El chofer cobraba dos veces.
      it('EL COBRO NO LLEVA EL REPARTO DENTRO', async () => {
        const p = arnes.montar();
        if (p.capabilities.splitAtCapture) return; // ese procesador sí reparte al capturar
        await p.authorize(cobro);
        const delatora = mencionaReparto(arnes.ultimaPeticion());
        expect(delatora, `el cobro menciona '${delatora}'`).toBeNull();
      });

      // La comisión del valet era la única transferencia de nueve sin clave:
      // un reintento la pagaba dos veces.
      it('LA CLAVE DE IDEMPOTENCIA LLEGA AL PROCESADOR', async () => {
        const p = arnes.montar();
        await p.authorize(cobro);
        expect(llevaLaClave(arnes.ultimaPeticion(), cobro.idempotencyKey)).toBe(true);
      });

      it('y también al capturar', async () => {
        const p = arnes.montar();
        await p.capture({ idempotencyKey: 'ride_conformidad_capture', providerRef: 'ref_1' });
        expect(llevaLaClave(arnes.ultimaPeticion(), 'ride_conformidad_capture')).toBe(true);
      });

      it('y al reembolsar', async () => {
        const p = arnes.montar();
        await p.refund({ idempotencyKey: 'ride_conformidad_refund', providerRef: 'ref_1' });
        expect(llevaLaClave(arnes.ultimaPeticion(), 'ride_conformidad_refund')).toBe(true);
      });
    });

    describe('cómo falla', () => {
      // Quien llama decide con esto: un rechazo no se reintenta por otro
      // camino, un fallo del procesador sí.
      it('UNA TARJETA RECHAZADA ES UN PagoRechazadoError CON CÓDIGO', async () => {
        const p = arnes.montarConRechazo();
        await expect(p.authorize(cobro)).rejects.toThrow(PagoRechazadoError);
        await p.authorize(cobro).catch((e: unknown) => {
          expect(e).toBeInstanceOf(PagoRechazadoError);
          expect((e as PagoRechazadoError).codigo).toBeTruthy();
          expect((e as PagoRechazadoError).provider).toBe(p.name);
        });
      });

      it('un fallo del procesador es un ProcesadorFalloError', async () => {
        const p = arnes.montarConFalloDelProcesador();
        await expect(p.authorize(cobro)).rejects.toThrow(ProcesadorFalloError);
      });

      it('y nunca se escapa el error crudo del SDK', async () => {
        const p = arnes.montarConFalloDelProcesador();
        await p.capture({ idempotencyKey: 'k_capture', providerRef: 'ref_1' }).catch((e: unknown) => {
          expect(
            e instanceof PagoRechazadoError || e instanceof ProcesadorFalloError,
            `se escapó ${(e as Error)?.name}`,
          ).toBe(true);
        });
      });
    });

    describe('el cobro en persona', () => {
      it('tampoco lleva el reparto dentro', async () => {
        const p = arnes.montar();
        if (!p.capabilities.tapToPay || !p.presentCharge || p.capabilities.splitAtCapture) return;
        await p.presentCharge({ ...cobro, hold: false });
        const delatora = mencionaReparto(arnes.ultimaPeticion());
        expect(delatora, `el cobro presencial menciona '${delatora}'`).toBeNull();
      });

      it('y también lleva la clave de idempotencia', async () => {
        const p = arnes.montar();
        if (!p.capabilities.tapToPay || !p.presentCharge) return;
        await p.presentCharge({ ...cobro, hold: false });
        expect(llevaLaClave(arnes.ultimaPeticion(), cobro.idempotencyKey)).toBe(true);
      });

      it('el token del lector viene firmado por su procesador', async () => {
        const p = arnes.montar();
        if (!p.capabilities.tapToPay || !p.terminalSession) return;
        const s = await p.terminalSession();
        expect(s.provider).toBe(p.name);
        expect(s.token).toBeTruthy();
      });
    });

    describe('probar las credenciales', () => {
      // Sin esto no se puede comprobar una credencial antes de guardarla, y
      // guardar una rota deja el servicio sin cobrar sin que nadie se entere
      // hasta el primer viaje.
      it('UN ADAPTADOR SABE DECIR SI SUS CREDENCIALES VALEN', async () => {
        const p = arnes.montar();
        expect(typeof p.ping).toBe('function');
        await expect(p.ping()).resolves.toBeUndefined();
      });

      it('y con credenciales malas, falla', async () => {
        const p = arnes.montarConFalloDelProcesador();
        await expect(p.ping()).rejects.toThrow();
      });
    });

    describe('los avisos del procesador', () => {
      it('una firma que no cuadra se rechaza, nunca se cree a medias', async () => {
        const p = arnes.montar();
        await expect(
          p.parseWebhook({ raw: Buffer.from('{}'), headers: {} }),
        ).rejects.toThrow();
      });
    });
  });
}
