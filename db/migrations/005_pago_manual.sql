-- ════════════════════════════════════════════════════════════════════════════
--  Liquidación manual: el dinero lo tiene URBONT y lo reparte una persona
--
--  Hasta ahora el reparto terminaba en una transferencia del procesador. Con
--  Square eso no existe —no sabe pagarle a terceros— y el modelo de negocio
--  cambió a propósito: el procesador deposita TODO en la cuenta de URBONT, el
--  libro apunta lo que se le debe a cada chofer y a cada valet, y alguien paga
--  por transferencia una o dos veces por semana.
--
--  Eso convierte el reparto en un apunte contable en vez de un movimiento. El
--  motor ya casi lo hacía: la parte de la plataforma se marca pagada sin mover
--  nada, y una parte sin cuenta de cobro se queda `pending` en lugar de
--  fallida. Lo que faltaba era que eso fuera una decisión y no un accidente, y
--  que exista la operación «esto ya se pagó».
-- ════════════════════════════════════════════════════════════════════════════


-- ── 1. Dónde cobra cada persona ─────────────────────────────────────────────
--
-- Los datos bancarios van CIFRADOS con la misma clave maestra que las
-- credenciales de las pasarelas (`CREDENTIALS_KEY`), y por el mismo motivo: un
-- volcado de la base no puede ser una lista de cuentas bancarias.
--
-- Lo único que el panel ve en claro es `pista` —los últimos dígitos— y el
-- nombre del titular, que es lo que hace falta para reconocer a quién se le
-- está pagando. El número completo sólo sale por una ruta explícita, para el
-- momento de hacer la transferencia, y esa ruta queda registrada.

CREATE TABLE IF NOT EXISTS payments.payout_accounts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payee_id         UUID        NOT NULL,
  payee_type       TEXT        NOT NULL CHECK (payee_type IN ('driver','valet')),

  method           TEXT        NOT NULL CHECK (method IN ('ach','zelle')),
  holder_name      TEXT        NOT NULL,
  bank_name        TEXT,

  -- JSON cifrado: {"routingNumber":"…","accountNumber":"…"} o {"zelleEmail":"…"}
  secreto_cifrado  TEXT        NOT NULL,
  -- Lo único que se enseña: "****4821" o "r***o@correo.com"
  pista            TEXT        NOT NULL,

  status           TEXT        NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','verified','rejected')),
  -- Por qué se rechazó, para que quien lo arregle sepa qué arreglar.
  status_reason    TEXT,

  updated_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Una cuenta por persona. Cambiarla es una operación explícita, no un efecto
-- colateral de pagar un viaje: es la misma regla que ya gobierna `payees`.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payout_accounts_persona
  ON payments.payout_accounts (payee_id);


-- ── 2. Cada pago que se hace a mano ─────────────────────────────────────────
--
-- Una fila = una transferencia real a una persona, que salda N partes del
-- reparto. `reference` es el número de confirmación del banco: sin él, un pago
-- discutido seis meses después no se puede demostrar.

CREATE TABLE IF NOT EXISTS payments.payouts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payee_id      UUID        NOT NULL,
  payee_type    TEXT        NOT NULL CHECK (payee_type IN ('driver','valet')),

  amount_cents  BIGINT      NOT NULL CHECK (amount_cents > 0),
  currency      CHAR(3)     NOT NULL DEFAULT 'USD',
  method        TEXT        NOT NULL CHECK (method IN ('ach','zelle','cash','other')),

  -- El comprobante del banco.
  reference     TEXT,
  notes         TEXT,

  -- El período que cubre este pago, para cuadrar contra la semana.
  period_start  TIMESTAMPTZ,
  period_end    TIMESTAMPTZ,

  paid_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payouts_persona
  ON payments.payouts (payee_id, paid_at DESC);


-- ── 3. El reparto, ahora con modo y con quién lo pagó ───────────────────────
--
-- `settlement_mode` dice cómo se salda esta parte:
--   · `provider` — la paga el procesador con una transferencia (Stripe Connect)
--   · `manual`   — la paga una persona por transferencia bancaria
--
-- Por defecto `provider`, que es lo que hay hoy: esta migración no cambia el
-- comportamiento de ningún reparto existente. El modo lo fija el servicio al
-- crear el reparto, según la configuración.

ALTER TABLE payments.splits
  ADD COLUMN IF NOT EXISTS settlement_mode TEXT NOT NULL DEFAULT 'provider'
    CHECK (settlement_mode IN ('provider','manual')),
  -- El pago manual que saldó esta parte. NULL mientras esté pendiente.
  ADD COLUMN IF NOT EXISTS payout_id UUID REFERENCES payments.payouts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_splits_pago_manual
  ON payments.splits (payout_id)
  WHERE payout_id IS NOT NULL;

-- Lo que la pantalla de pagos consulta todo el rato: qué se le debe a quién.
-- Parcial a propósito: las partes ya pagadas son la mayoría y no se miran.
CREATE INDEX IF NOT EXISTS idx_splits_por_pagar_persona
  ON payments.splits (beneficiary_type, beneficiary_id, created_at)
  WHERE status IN ('pending','failed') AND beneficiary_type <> 'platform';


-- ── 4. El acumulado por persona ─────────────────────────────────────────────
--
-- Es una vista y no una columna a propósito: un saldo guardado se desincroniza
-- del libro en cuanto algo falla a medias, y entonces hay dos verdades. Aquí la
-- única verdad son las partes, y el saldo se deriva.

CREATE OR REPLACE VIEW payments.saldos_por_pagar AS
SELECT
  s.beneficiary_type                      AS payee_type,
  s.beneficiary_id                        AS payee_id,
  COUNT(*)                                AS partes_pendientes,
  SUM(s.amount_cents)::BIGINT             AS total_cents,
  MIN(s.created_at)                       AS desde,
  MAX(s.created_at)                       AS hasta
FROM payments.splits s
WHERE s.status IN ('pending','failed')
  AND s.beneficiary_type <> 'platform'
  AND s.amount_cents > 0
GROUP BY s.beneficiary_type, s.beneficiary_id;
