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
  PagoNoAdoptableError,
  PagoRechazadoError,
  ProcesadorFalloError,
  type AdoptPaymentCommand,
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

  /**
   * Lo más largo que admite su procesador como clave de idempotencia, o `null`
   * si no la limita. **Es obligatorio a propósito.**
   *
   * Las claves de urbont-api miden entre 51 y 67 caracteres, y la suite las usa
   * de ese tamaño. Square rechaza cualquiera de más de 45, y el adaptador las
   * mandaba tal cual: en producción, una ristra de 502 y todos los cobros,
   * capturas y reembolsos por Square rotos. No se había visto porque esta suite
   * usaba claves de 26 caracteres, que caben en cualquier procesador, y por tanto
   * ningún adaptador podía fallar por largo. Que sea un campo que hay que rellenar
   * obliga a quien escriba el siguiente a hacerse la pregunta, en vez de
   * descubrirla en producción.
   */
  limiteDeClave: number | null;

  /**
   * La clave tal como el adaptador se la manda al procesador. Por defecto, la
   * misma. Un adaptador cuyo procesador limita el largo la acorta —de forma
   * determinista, porque un reintento tiene que llegar con la misma clave— y el
   * arnés dice aquí cómo.
   */
  claveEnviada?: (clave: string) => string;

  /** Monta el adaptador de forma que la siguiente llamada la rechace la tarjeta. */
  montarConRechazo(): PaymentProvider;

  /** Monta el adaptador de forma que la siguiente llamada falle por el procesador. */
  montarConFalloDelProcesador(): PaymentProvider;

  /**
   * **Obligatorio** si el adaptador tiene `adoptPayment` (el cobro lo crea el SDK
   * del teléfono y el servidor lo adopta después).
   *
   * Monta el adaptador con un pago de `providerRef` ya hecho y exactamente igual a
   * `esperado`, para comprobar que se adopta; la suite pide después el mismo pago
   * con un importe distinto y exige que se rechace. Sin esa segunda mitad, adoptar
   * sería aceptar lo que diga el teléfono.
   */
  adopcion?: {
    montar(): PaymentProvider;
    providerRef: string;
    esperado: AdoptPaymentCommand['expected'];
  };
}

/**
 * Un viaje de verdad: tan largo como el UUID de los viajes reales, y por eso la
 * clave resultante (`ride_<uuid>_authorize`) mide 51 caracteres, igual que la de
 * urbont-api. Con una más corta esta suite no probaría nada sobre el largo.
 */
const VIAJE_REAL = '8e2d4a1b-5c3f-4a7e-9b1d-2f6c8e0a4b7d';
const CLAVE_COBRO = `ride_${VIAJE_REAL}_authorize`;
const CLAVE_CAPTURA = `${CLAVE_COBRO}_capture`;        // 59: lo que manda PaymentsService
const CLAVE_REEMBOLSO = `${CLAVE_COBRO}_refund`;       // 58

const COBRO: AuthorizeCommand = {
  idempotencyKey: CLAVE_COBRO,
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
  /** La clave tal como tiene que llegar al procesador: la misma, o su forma acortada. */
  const enviada = (clave: string): string => arnes.claveEnviada?.(clave) ?? clave;
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
          expect(p.adoptPayment).toBeUndefined();
          expect(p.deviceAttemptKey).toBeUndefined();
        }
        if (!p.capabilities.increaseAuthorization) expect(p.increaseAuthorization).toBeUndefined();
      });

      // Tap to Pay son DOS mitades y la que se olvida es siempre la misma: el
      // token de sesión. Sin él, el SDK del teléfono no arranca y el cobro
      // presencial no existe, por mucho que `presentCharge` esté escrito.
      //
      // La primera mitad tiene dos formas, según quién crea el cobro: el servidor
      // (`presentCharge`, Stripe) o el SDK del teléfono (`adoptPayment`, Square),
      // en cuyo caso el servidor sólo puede adoptar después lo que ya se cobró.
      it('TAP TO PAY EXIGE EL COBRO (O SU ADOPCIÓN) Y EL TOKEN DEL LECTOR', () => {
        const p = arnes.montar();
        if (!p.capabilities.tapToPay) return;
        expect(
          typeof p.presentCharge === 'function' || typeof p.adoptPayment === 'function',
          'falta presentCharge (el servidor crea el cobro) o adoptPayment (lo crea el teléfono)',
        ).toBe(true);
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
        expect(llevaLaClave(arnes.ultimaPeticion(), enviada(cobro.idempotencyKey))).toBe(true);
      });

      // El fallo que costó una ristra de 502: las claves REALES miden 51–67 y
      // Square rechaza más de 45.
      it('LAS CLAVES REALES DE URBONT CABEN EN EL LÍMITE DE SU PROCESADOR', async () => {
        const limite = arnes.limiteDeClave;
        if (limite === null) return; // un procesador que no limita el largo
        for (const clave of [CLAVE_COBRO, CLAVE_CAPTURA, CLAVE_REEMBOLSO]) {
          expect(clave.length, 'la suite tiene que usar claves de tamaño real').toBeGreaterThanOrEqual(51);
          const llega = enviada(clave);
          expect(
            llega.length,
            `«${clave}» (${clave.length}) llega como «${llega}» (${llega.length}) y su procesador sólo admite ${limite}`,
          ).toBeLessThanOrEqual(limite);
        }
      });

      // Acortar mal es peor que no acortar: un reintento tiene que llegar con la
      // misma clave, y dos operaciones distintas no pueden compartirla.
      it('LA CLAVE QUE LLEGA ES ESTABLE Y NO CONFUNDE OPERACIONES', () => {
        expect(enviada(CLAVE_COBRO)).toBe(enviada(CLAVE_COBRO));
        const tres = new Set([enviada(CLAVE_COBRO), enviada(CLAVE_CAPTURA), enviada(CLAVE_REEMBOLSO)]);
        expect(tres.size).toBe(3);
      });

      it('y también al capturar', async () => {
        const p = arnes.montar();
        await p.capture({ idempotencyKey: CLAVE_CAPTURA, providerRef: 'ref_1' });
        expect(llevaLaClave(arnes.ultimaPeticion(), enviada(CLAVE_CAPTURA))).toBe(true);
      });

      it('y al reembolsar', async () => {
        const p = arnes.montar();
        await p.refund({ idempotencyKey: CLAVE_REEMBOLSO, providerRef: 'ref_1' });
        expect(llevaLaClave(arnes.ultimaPeticion(), enviada(CLAVE_REEMBOLSO))).toBe(true);
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
        expect(llevaLaClave(arnes.ultimaPeticion(), enviada(cobro.idempotencyKey))).toBe(true);
      });

      it('el token del lector viene firmado por su procesador', async () => {
        const p = arnes.montar();
        if (!p.capabilities.tapToPay || !p.terminalSession) return;
        const s = await p.terminalSession();
        expect(s.provider).toBe(p.name);
        expect(s.token).toBeTruthy();
      });
    });

    // Cuando el cobro lo crea el SDK del teléfono, el servidor ya no controla qué
    // se cobra: lo que hace es COMPROBARLO. Estas reglas son lo que impide que un
    // adaptador acepte como bueno cualquier pago que diga el dispositivo.
    describe('el cobro en persona con el SDK del teléfono', () => {
      it('el token de sesión dice que cobra el teléfono', async () => {
        const p = arnes.montar();
        if (!p.adoptPayment || p.presentCharge || !p.terminalSession) return;
        expect((await p.terminalSession()).flow).toBe('device-sdk');
      });

      it('da una clave de intento para el teléfono que cabe en el límite del procesador', () => {
        const p = arnes.montar();
        if (!p.adoptPayment || p.presentCharge) return;
        expect(typeof p.deviceAttemptKey, 'falta deviceAttemptKey').toBe('function');
        if (arnes.limiteDeClave !== null) {
          expect(p.deviceAttemptKey!(CLAVE_COBRO).length).toBeLessThanOrEqual(arnes.limiteDeClave);
        }
        // Determinista: un reintento tiene que llegar con la misma clave.
        expect(p.deviceAttemptKey!(CLAVE_COBRO)).toBe(p.deviceAttemptKey!(CLAVE_COBRO));
      });

      it('el arnés trae lo necesario para probar la adopción', () => {
        const p = arnes.montar();
        if (!p.adoptPayment) return;
        expect(arnes.adopcion, 'falta `adopcion` en el arnés: sin ella no se prueba que adoptar comprueba algo').toBeDefined();
      });

      it('ADOPTA el pago que es exactamente el esperado, y lo devuelve cobrado', async () => {
        if (!arnes.adopcion) return;
        const p = arnes.adopcion.montar();
        const a = await p.adoptPayment!({ providerRef: arnes.adopcion.providerRef, expected: arnes.adopcion.esperado });
        expect(a.status).toBe('captured');
        expect(a.amount).toBe(arnes.adopcion.esperado.amount);
        expect(a.provider).toBe(p.name);
      });

      it('NO ADOPTA un pago de otro importe: un teléfono manipulado no puede cobrar menos', async () => {
        if (!arnes.adopcion) return;
        const p = arnes.adopcion.montar();
        const e = await p
          .adoptPayment!({
            providerRef: arnes.adopcion.providerRef,
            expected: { ...arnes.adopcion.esperado, amount: arnes.adopcion.esperado.amount + 1 },
          })
          .catch((x: unknown) => x);
        expect(e, 'adoptó un pago que no era el esperado').toBeInstanceOf(PagoNoAdoptableError);
      });

      it('NO ADOPTA un pago de otro viaje', async () => {
        if (!arnes.adopcion || arnes.adopcion.esperado.reference === undefined) return;
        const p = arnes.adopcion.montar();
        const e = await p
          .adoptPayment!({
            providerRef: arnes.adopcion.providerRef,
            expected: { ...arnes.adopcion.esperado, reference: 'otro-viaje' },
          })
          .catch((x: unknown) => x);
        expect(e).toBeInstanceOf(PagoNoAdoptableError);
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
