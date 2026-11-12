/**
 * El contrato único de URBONT PAYMENTS.
 *
 * Todo procesador —Stripe, Square, Adyen, Finix, PayPal, ACH— entra por aquí y
 * sólo por aquí. El resto del servicio no sabe cuál está activo, y la
 * aplicación de URBONT no sabe siquiera que existen.
 *
 * Dos reglas gobiernan este archivo:
 *
 *  1. **Nada de tipos del proveedor cruza esta frontera.** Ni `Stripe.PaymentIntent`
 *     ni `pspReference`: lo que sale de un adaptador son los tipos de aquí. Es la
 *     diferencia entre poder cambiar de proveedor y no poder.
 *  2. **El importe y el destinatario nunca vienen de fuera.** Los comandos llevan
 *     identificadores de URBONT; quien resuelve cuánto y a quién es el servicio,
 *     contra su propia base de datos.
 */

/** Los procesadores que el servicio sabe nombrar. Añadir uno es añadir un módulo. */
export type ProviderName = 'stripe' | 'square' | 'adyen' | 'finix' | 'paypal' | 'ach';

/** Importes siempre en la unidad mínima de la moneda (centavos), nunca en coma flotante. */
export type Cents = number;

export type Currency = 'USD' | 'COP' | 'EUR' | 'MXN';

/**
 * Qué sabe hacer cada procesador.
 *
 * Sin esto, el contrato se degradaría al mínimo común denominador: Adyen reparte
 * en la propia captura y Stripe no; Square hace Tap to Pay con su SDK y PayPal
 * no lo hace en absoluto. El registro elige adaptador por operación, no sólo por
 * proveedor por defecto.
 */
export interface ProviderCapabilities {
  /** Autoriza primero y cobra después (hold). Sin esto, no hay reservas. */
  manualCapture: boolean;
  /** Puede capturar menos de lo autorizado (cancelaciones con penalización). */
  partialCapture: boolean;
  /**
   * Puede SUBIR una autorización ya hecha, antes de capturarla.
   *
   * Hace falta para el cargo por espera: el viaje se autoriza al reservar y el
   * importe final sólo se sabe al terminar. Sin esto, la espera se le regala al
   * pasajero, porque capturar nunca puede pasar del importe autorizado.
   */
  increaseAuthorization: boolean;
  /** Guarda tarjetas para cobrar sin el pasajero delante. */
  savedCards: boolean;
  /** Puede pagar a terceros: choferes y valets. */
  payouts: boolean;
  /** Reparte en la propia captura, sin una transferencia aparte. */
  splitAtCapture: boolean;
  /** Cobro presencial con el teléfono (Tap to Pay on iPhone). */
  tapToPay: boolean;
  /** Débito bancario directo. */
  bankDebit: boolean;
  /** Monedas que acepta esta cuenta. */
  currencies: Currency[];
}

/** Qué se está cobrando. Determina el reparto, no el importe. */
export type ChargeKind =
  | 'ride'
  | 'tip'
  | 'cleaning'
  | 'hourly_extra'
  | 'cancellation_fee'
  | 'no_show_fee'
  | 'penalty';

export type AuthorizationStatus =
  | 'requires_action'
  | 'authorized'
  | 'captured'
  | 'failed'
  | 'voided';

export interface Authorization {
  /** Referencia del proveedor: `pi_…`, `pspReference`, el id que sea. */
  providerRef: string;
  provider: ProviderName;
  status: AuthorizationStatus;
  amount: Cents;
  currency: Currency;
  /** Lo que el cliente necesita para terminar el cobro, si hace falta. */
  clientSecret?: string;
  /**
   * El cargo concreto dentro del cobro, cuando el procesador los distingue.
   *
   * Hace falta para repartir: la transferencia a un chofer va atada al cargo
   * del que sale, no al cobro. Y es lo que aparece en el extracto del
   * procesador, así que es por donde se concilia.
   */
  chargeRef?: string;
  /** Tal como vino del proveedor, para poder auditar sin volver a preguntar. */
  raw?: unknown;
}

export interface Capture {
  providerRef: string;
  provider: ProviderName;
  captured: Cents;
  currency: Currency;
  /** El cargo concreto, cuando el proveedor lo distingue de la autorización. */
  chargeRef?: string;
  raw?: unknown;
}

export interface Refund {
  providerRef: string;
  provider: ProviderName;
  refunded: Cents;
  currency: Currency;
  raw?: unknown;
}

export interface Transfer {
  providerRef: string;
  provider: ProviderName;
  amount: Cents;
  currency: Currency;
  /** La cuenta del beneficiario en ese proveedor. */
  payeeRef: string;
  raw?: unknown;
}

export interface SavedCard {
  providerRef: string;
  provider: ProviderName;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
}

export type PayeeStatus = 'pending' | 'active' | 'restricted' | 'rejected';

export interface PayeeAccount {
  providerRef: string;
  provider: ProviderName;
  status: PayeeStatus;
  /** A dónde mandar al beneficiario para que termine su alta. */
  onboardingUrl?: string;
}

/**
 * Lo que URBONT entiende de un aviso del proveedor.
 *
 * Cada adaptador traduce su propio vocabulario a esto, de modo que añadir un
 * procesador no toca ni una línea de quien reacciona a los eventos.
 */
export type ProviderEventType =
  | 'payment.authorized'
  | 'payment.captured'
  | 'payment.failed'
  | 'refund.succeeded'
  | 'chargeback.opened'
  | 'chargeback.closed'
  | 'payee.updated'
  | 'payout.paid'
  | 'payout.failed';

export interface ProviderEvent {
  /** El id del evento EN EL PROVEEDOR. Es la clave de la idempotencia. */
  eventId: string;
  /**
   * El id del objeto que disparó el evento: el reembolso, la disputa, la
   * transferencia.
   *
   * No es lo mismo que `providerRef`, que es siempre el cobro. Hace falta
   * porque un reembolso llega por dos caminos —lo pedimos nosotros y el
   * procesador nos lo cuenta— y los asientos tienen que ser los mismos: la
   * identidad del asiento es esta referencia, que los dos caminos conocen.
   */
  objectRef?: string;
  provider: ProviderName;
  type: ProviderEventType;
  providerRef: string | null;
  amount?: Cents;
  currency?: Currency;
  occurredAt: Date;
  raw: unknown;
}

// ── Comandos ────────────────────────────────────────────────────────────────
//
// Llevan identificadores y la intención; nunca el destinatario del dinero.

export interface AuthorizeCommand {
  idempotencyKey: string;
  kind: ChargeKind;
  amount: Cents;
  currency: Currency;
  /** El cliente en ese proveedor, si ya lo tiene. */
  customerRef?: string;
  /** La tarjeta guardada con la que cobrar, si el cobro no es interactivo. */
  cardRef?: string;
  /** `false` cobra en el acto; `true` sólo retiene (reservas). */
  hold: boolean;
  /**
   * `true` (el valor por defecto cuando hay tarjeta guardada) cobra sin el
   * pasajero delante: la propina, el cargo de limpieza, el extra por hora.
   *
   * `false` cuando el pasajero SÍ está delante y puede resolver una
   * autenticación del banco en el momento. La diferencia la ve el banco y
   * cambia qué cobros acepta.
   */
  offSession?: boolean;
  /** Lo que verá el pasajero en el extracto de su tarjeta. */
  description?: string;
  /** Impuesto ya calculado, incluido en `amount`. Se registra, no se recalcula. */
  taxAmount?: Cents;
  /** Para trazar: viaje, pasajero. Nunca para decidir importes. */
  reference: { rideId?: string; payerId?: string };
  /**
   * Traza libre que el adaptador vuelca al mecanismo del procesador (metadata
   * en Stripe, `additionalData` en Adyen, `reference_id` en Square).
   *
   * **Nunca decide nada aquí dentro.** Existe porque durante la convivencia
   * `urbont-api` sigue leyendo del cobro lo que escribió al crearlo
   * (`commission_rate`, `tax_calculation_id`…) para pagarle al chofer; si el
   * cobro del micro no lo llevara, ese reparto cambiaría en silencio.
   *
   * Acotada a `LIMITE_METADATA` claves y `LIMITE_VALOR_METADATA` caracteres por
   * valor, que es lo que aguanta el procesador más estrecho.
   */
  metadata?: Record<string, string>;
}

/** Lo que aceptan los procesadores en su metadata, por lo bajo. */
export const LIMITE_METADATA = 10;
export const LIMITE_VALOR_METADATA = 200;

export interface IncreaseAuthorizationCommand {
  idempotencyKey: string;
  providerRef: string;
  /** El **nuevo total** autorizado, no el incremento. */
  amount: Cents;
}

export interface CaptureCommand {
  idempotencyKey: string;
  providerRef: string;
  /** Captura parcial; omitido captura lo autorizado. */
  amount?: Cents;
}

export interface VoidCommand {
  idempotencyKey: string;
  providerRef: string;
}

export interface RefundCommand {
  idempotencyKey: string;
  providerRef: string;
  /** Reembolso parcial; omitido devuelve todo. */
  amount?: Cents;
  reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
}

export interface SaveCardCommand {
  idempotencyKey: string;
  customerRef?: string;
  payerId: string;
  /**
   * El token que la app generó al tokenizar la tarjeta.
   *
   * Opcional porque los dos procesadores lo resuelven al revés: Stripe crea un
   * `SetupIntent` en el servidor y la app lo confirma después, así que no
   * necesita token; Square exige que la app tokenice primero y manda ese token
   * a `cards.create`, así que sin él no puede guardar nada.
   *
   * Un adaptador que lo necesite y no lo reciba **se niega en voz alta** en vez
   * de guardar algo a medias.
   */
  cardToken?: string;
  /**
   * El correo del pagador, si quien llama lo tiene.
   *
   * Square **exige** al menos un dato identificativo para crear un cliente
   * (`given_name`, `family_name`, `company_name`, `email_address` o
   * `phone_number`): sólo con una referencia interna responde 400. Cuando no
   * viene, el adaptador pone un valor por defecto para no fallar, pero el
   * correo hace que la ficha sea reconocible en el panel del procesador.
   */
  payerEmail?: string;
}

/**
 * Cómo termina de guardarse una tarjeta.
 *
 * Es una unión discriminada y no un objeto con campos opcionales a propósito:
 * los dos procesadores acaban en sitios opuestos, y quien llama tiene que
 * tratar los dos casos. Con campos opcionales, un `clientSecret` indefinido se
 * colaría hasta la app y fallaría allí, lejos de donde se decidió.
 */
export type ResultadoDeGuardado =
  /** Falta un paso en el cliente: la app confirma con este secreto. (Stripe) */
  | { modo: 'confirmar-en-cliente'; clientSecret: string; customerRef: string }
  /** Ya está guardada: la app tokenizó antes y el servidor sólo la registró. (Square) */
  | { modo: 'guardada'; card: SavedCard; customerRef: string };

export interface ChargeSavedCardCommand extends AuthorizeCommand {
  cardRef: string;
  customerRef: string;
}

export interface OnboardPayeeCommand {
  idempotencyKey: string;
  payeeId: string;
  email?: string;
  country: string;
  returnUrl: string;
  refreshUrl: string;
}

export interface TransferCommand {
  idempotencyKey: string;
  payeeRef: string;
  amount: Cents;
  currency: Currency;
  /** El cobro del que sale el dinero, cuando el proveedor lo necesita. */
  sourceRef?: string;
  description?: string;
  reference: { rideId?: string; beneficiaryId?: string };
}

export interface PresentChargeCommand extends AuthorizeCommand {
  /** El lector o terminal que cobra en persona. */
  terminalRef?: string;
}

/**
 * Lo que el teléfono del chofer necesita para convertirse en lector.
 *
 * Es la pieza que faltaba para que Tap to Pay sea de verdad intercambiable. El
 * cobro presencial ya estaba en el contrato (`presentCharge`), pero el SDK que
 * corre en el teléfono no puede empezar sin un token que **sólo el backend
 * puede pedir**, y ese token es lo más propio de cada procesador que hay en
 * todo esto: Stripe lo llama *connection token* y lo ata a una *location*,
 * Adyen y Square tienen cada uno el suyo.
 *
 * Sin esto en el contrato, la app tendría que saber qué procesador está activo
 * para saber a qué endpoint pedir el token, y eso es exactamente lo que este
 * servicio existe para evitar.
 */
export interface TerminalSession {
  provider: ProviderName;
  /** El token con el que el SDK del teléfono se conecta. */
  token: string;
  /** Cuándo caduca, si el procesador lo dice. */
  expiresAt?: Date;
  /**
   * El sitio al que se conecta el lector, si el procesador tiene ese concepto.
   * En Stripe es la *location*; otros no lo usan.
   */
  locationRef?: string;
}

/**
 * Una línea del extracto del procesador.
 *
 * `netCents` es lo que de verdad quedó: lo capturado menos lo devuelto. Es el
 * único número con el que se puede cuadrar, porque es el que el procesador
 * acabará ingresando.
 */
export interface SettlementCharge {
  chargeRef: string;
  providerRef: string | null;
  netCents: Cents;
  currency: Currency;
  createdAt: Date;
}

export interface WebhookRequest {
  /** El cuerpo CRUDO. Si se parsea antes, la firma no se puede verificar. */
  raw: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Lo que implementa cada procesador.
 *
 * Los métodos opcionales son los que no todos saben hacer; antes de llamarlos se
 * consulta `capabilities`.
 */
export interface PaymentProvider {
  readonly name: ProviderName;
  readonly capabilities: ProviderCapabilities;

  authorize(cmd: AuthorizeCommand): Promise<Authorization>;

  /**
   * Lee un cobro ya existente. **No mueve dinero.**
   *
   * Hace falta para devolver el `clientSecret` cuando quien llama repite la
   * petición de cobro: la clave de idempotencia devuelve la misma fila del
   * libro, pero el secreto con el que la app confirma la tarjeta vive en el
   * procesador, no en el libro.
   */
  getAuthorization(providerRef: string): Promise<Authorization>;
  capture(cmd: CaptureCommand): Promise<Capture>;
  voidAuthorization(cmd: VoidCommand): Promise<void>;
  refund(cmd: RefundCommand): Promise<Refund>;

  saveCard(cmd: SaveCardCommand): Promise<ResultadoDeGuardado>;
  listCards(customerRef: string): Promise<SavedCard[]>;

  /**
   * Cobra contra una tarjeta ya guardada.
   *
   * Devuelve `Authorization` y no `Capture` por un motivo que costó dinero:
   * **crear el cobro no es cobrarlo.** El banco puede pedir autenticación y
   * dejarlo en `requires_action` sin que nadie lance un error. Devolviendo un
   * `Capture` —que sólo sabe de importes— quien llama no tenía forma de
   * distinguirlo, y daba por bueno un cobro que no había ocurrido: es
   * literalmente lo que le mostró a un chofer una propina de $10 que ningún
   * pasajero pagó (`urbont-api/server/services/rideTip.ts`).
   */
  chargeSavedCard(cmd: ChargeSavedCardCommand): Promise<Authorization>;

  onboardPayee(cmd: OnboardPayeeCommand): Promise<PayeeAccount>;
  payeeStatus(payeeRef: string): Promise<PayeeStatus>;
  transfer(cmd: TransferCommand): Promise<Transfer>;

  /** Sólo con `capabilities.increaseAuthorization`. */
  increaseAuthorization?(cmd: IncreaseAuthorizationCommand): Promise<Authorization>;

  /** Sólo con `capabilities.tapToPay`. */
  presentCharge?(cmd: PresentChargeCommand): Promise<Authorization>;

  /**
   * El token de sesión del lector. Sólo con `capabilities.tapToPay`.
   *
   * Caduca pronto y no se guarda: se pide una vez por sesión de cobro.
   */
  terminalSession?(): Promise<TerminalSession>;

  /**
   * Comprueba que las credenciales valen, sin mover dinero.
   *
   * Una lectura barata y autenticada: si el procesador contesta, la clave es
   * buena. Existe para poder **probar antes de guardar** una credencial que
   * llega del panel; guardar una rota dejaría el servicio sin cobrar y a quien
   * la pegó sin enterarse hasta el primer viaje.
   */
  ping(): Promise<void>;

  /** Verifica la firma y traduce. Debe lanzar si la firma no cuadra. */
  parseWebhook(req: WebhookRequest): Promise<ProviderEvent[]>;

  /**
   * El extracto del procesador en un período, para cuadrar.
   *
   * Es una lectura y puede ser larga: quien llama pone un tope. Un cuadre que
   * se trae un año entero bloquea el servicio, y un cuadre que no se hace es un
   * descuadre que crece sin que nadie lo vea.
   */
  listCharges(desde: Date, hasta: Date, limite: number): Promise<SettlementCharge[]>;
}

// ── Errores del dominio ─────────────────────────────────────────────────────
//
// Los adaptadores traducen a esto los errores de su procesador. Si no lo
// hicieran, quien llama tendría que reconocer un `StripeCardError` para saber
// que la tarjeta fue rechazada, y añadir Square obligaría a reconocer también
// los suyos: exactamente lo que este contrato existe para evitar.

/** La tarjeta (o el banco) dijo no. Reintentar no ayuda. */
export class PagoRechazadoError extends Error {
  constructor(
    public readonly codigo: string,
    mensaje: string,
    public readonly provider: ProviderName,
  ) {
    super(mensaje);
    this.name = 'PagoRechazadoError';
  }
}

/**
 * La firma de un aviso del procesador no cuadra.
 *
 * Vive en el contrato y no en cada adaptador porque quien decide qué responder
 * —un 400 que el procesador no reintenta— no puede estar reconociendo el error
 * concreto de Stripe: con Square tendría que reconocer el suyo.
 */
export class FirmaDeWebhookInvalidaError extends Error {
  constructor(
    public readonly provider: ProviderName,
    detalle: string,
  ) {
    super(`La firma del webhook de ${provider} no es válida: ${detalle}`);
    this.name = 'FirmaDeWebhookInvalidaError';
  }
}

/** El procesador falló o no contestó. Reintentar puede ayudar. */
export class ProcesadorFalloError extends Error {
  constructor(
    public readonly provider: ProviderName,
    mensaje: string,
    public readonly causa?: unknown,
  ) {
    super(mensaje);
    this.name = 'ProcesadorFalloError';
  }
}

/** Token de inyección: los adaptadores se registran contra esto, no contra una clase. */
export const PAYMENT_PROVIDERS = Symbol('PAYMENT_PROVIDERS');
