-- URBONT PAYMENTS — esquema inicial
--
-- Vive en el mismo Postgres que el resto de URBONT pero en su propio esquema,
-- para poder conciliar contra `public.rides` sin mezclar permisos. Todo es
-- idempotente: estas migraciones se aplican al arrancar el servicio.
--
-- Tres restricciones sostienen la corrección del dinero y no son negociables:
--   · transactions.idempotency_key ÚNICA  → nada se cobra dos veces
--   · splits (transaction, beneficiario)  → nadie cobra dos veces del mismo cobro
--   · webhook_events (provider, event_id) → un aviso repetido no mueve nada

CREATE SCHEMA IF NOT EXISTS payments;

-- ── Intenciones de cobro ────────────────────────────────────────────────────
--
-- Una fila por intención, con independencia del procesador. `provider` y
-- `provider_ref` son lo que permite que una operación posterior vuelva al mismo
-- sitio: capturar, reembolsar o disputar un cobro de Stripe va a Stripe aunque
-- el procesador por defecto ya sea otro.
CREATE TABLE IF NOT EXISTS payments.transactions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  TEXT        NOT NULL,
  provider         TEXT        NOT NULL,
  provider_ref     TEXT,
  kind             TEXT        NOT NULL,
  ride_id          UUID,
  payer_id         UUID,
  amount_cents     INTEGER     NOT NULL CHECK (amount_cents >= 0),
  tax_cents        INTEGER     NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  currency         CHAR(3)     NOT NULL DEFAULT 'USD',
  status           TEXT        NOT NULL DEFAULT 'pending',
  authorized_at    TIMESTAMPTZ,
  captured_at      TIMESTAMPTZ,
  failed_at        TIMESTAMPTZ,
  failure_code     TEXT,
  raw              JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT transactions_status_valido CHECK (
    status IN ('pending','authorized','captured','failed','refunded','voided')
  )
);

-- Lo que impide cobrar dos veces por un reintento del cliente o de la API.
CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_idempotency
  ON payments.transactions (idempotency_key);

-- Un cobro del procesador se corresponde con una sola fila nuestra.
CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_provider_ref
  ON payments.transactions (provider, provider_ref)
  WHERE provider_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_ride     ON payments.transactions (ride_id);
CREATE INDEX IF NOT EXISTS idx_transactions_pendientes
  ON payments.transactions (created_at)
  WHERE status IN ('pending','authorized');

-- ── Reparto ─────────────────────────────────────────────────────────────────
--
-- Se calcula y se guarda ANTES de mover un centavo, y cada beneficiario es una
-- fila con su propio estado. La restricción única es la que hace imposible por
-- construcción el doble pago que la auditoría de septiembre encontró en el
-- flujo de valet.
CREATE TABLE IF NOT EXISTS payments.splits (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id       UUID        NOT NULL REFERENCES payments.transactions(id) ON DELETE CASCADE,
  beneficiary_type     TEXT        NOT NULL CHECK (beneficiary_type IN ('driver','valet','platform')),
  beneficiary_id       UUID,
  amount_cents         INTEGER     NOT NULL CHECK (amount_cents >= 0),
  rate                 NUMERIC(5,4),
  status               TEXT        NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','sent','paid','failed','reversed')),
  provider             TEXT,
  provider_transfer_ref TEXT,
  failure_code         TEXT,
  paid_at              TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Un beneficiario cobra UNA vez de un cobro. Esto es el antídoto del doble pago.
CREATE UNIQUE INDEX IF NOT EXISTS uq_splits_beneficiario
  ON payments.splits (transaction_id, beneficiary_type, COALESCE(beneficiary_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX IF NOT EXISTS idx_splits_por_pagar
  ON payments.splits (created_at)
  WHERE status IN ('pending','failed');

-- ── Libro contable ──────────────────────────────────────────────────────────
--
-- Sólo inserciones: un asiento no se corrige, se compensa con otro. Es lo que
-- permite responder "de dónde salió este dinero" meses después.
CREATE TABLE IF NOT EXISTS payments.ledger_entries (
  id              BIGSERIAL PRIMARY KEY,
  transaction_id  UUID REFERENCES payments.transactions(id) ON DELETE SET NULL,
  split_id        UUID REFERENCES payments.splits(id) ON DELETE SET NULL,
  entry_type      TEXT        NOT NULL,
  account         TEXT        NOT NULL,
  amount_cents    BIGINT      NOT NULL,
  currency        CHAR(3)     NOT NULL DEFAULT 'USD',
  provider        TEXT,
  provider_ref    TEXT,
  memo            TEXT,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_transaction ON payments.ledger_entries (transaction_id);
CREATE INDEX IF NOT EXISTS idx_ledger_fecha       ON payments.ledger_entries (occurred_at);

-- ── Beneficiarios ───────────────────────────────────────────────────────────
--
-- La cuenta de un chofer o un valet EN CADA procesador. Un mismo chofer puede
-- tener cuenta en Stripe y en Adyen a la vez durante una migración, y hay que
-- poder pagarle por la que corresponda.
CREATE TABLE IF NOT EXISTS payments.payees (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payee_id      UUID        NOT NULL,
  payee_type    TEXT        NOT NULL CHECK (payee_type IN ('driver','valet')),
  provider      TEXT        NOT NULL,
  provider_ref  TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','active','restricted','rejected')),
  country       CHAR(2)     NOT NULL DEFAULT 'US',
  checked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payees_persona_proveedor
  ON payments.payees (payee_id, provider);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payees_referencia
  ON payments.payees (provider, provider_ref);

-- ── Avisos de los procesadores ──────────────────────────────────────────────
--
-- El aviso se guarda ANTES de actuar sobre él, y la clave única es lo que hace
-- que un reintento del procesador no mueva dinero por segunda vez.
CREATE TABLE IF NOT EXISTS payments.webhook_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      TEXT        NOT NULL,
  event_id      TEXT        NOT NULL,
  event_type    TEXT        NOT NULL,
  provider_ref  TEXT,
  status        TEXT        NOT NULL DEFAULT 'received'
                CHECK (status IN ('received','processed','ignored','failed')),
  attempts      INTEGER     NOT NULL DEFAULT 0,
  last_error    TEXT,
  payload       JSONB       NOT NULL,
  occurred_at   TIMESTAMPTZ,
  processed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_events_proveedor
  ON payments.webhook_events (provider, event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_sin_procesar
  ON payments.webhook_events (created_at)
  WHERE status IN ('received','failed');

-- ── Conciliación ────────────────────────────────────────────────────────────
--
-- Qué decía el procesador y qué decimos nosotros, cada día. Un descuadre que
-- nadie mira es un descuadre que crece.
CREATE TABLE IF NOT EXISTS payments.reconciliation_runs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider           TEXT        NOT NULL,
  periodo_inicio     TIMESTAMPTZ NOT NULL,
  periodo_fin        TIMESTAMPTZ NOT NULL,
  cobros_proveedor   INTEGER     NOT NULL DEFAULT 0,
  cobros_propios     INTEGER     NOT NULL DEFAULT 0,
  centavos_proveedor BIGINT      NOT NULL DEFAULT 0,
  centavos_propios   BIGINT      NOT NULL DEFAULT 0,
  descuadres         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  status             TEXT        NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','descuadre','error')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_periodo
  ON payments.reconciliation_runs (provider, periodo_inicio);
