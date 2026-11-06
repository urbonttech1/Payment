-- ── La referencia del cargo, para poder repartir ────────────────────────────
--
-- Una transferencia a un chofer tiene que ir atada al cargo del que sale
-- (`source_transaction` en Stripe). Sin eso falla con `balance_insufficient` en
-- cuanto los payouts automáticos barren el saldo de la plataforma, que es lo que
-- pasa cada madrugada.
--
-- El cargo no es lo mismo que el cobro: un PaymentIntent (`pi_…`) tiene dentro
-- un cargo (`ch_…`), y es el segundo el que financia la transferencia. Se
-- guarda al capturar, que es cuando el procesador lo dice.

ALTER TABLE payments.transactions
  ADD COLUMN IF NOT EXISTS charge_ref TEXT;

-- Para la conciliación: buscar por el cargo es lo que hace el extracto del
-- procesador, que no habla de PaymentIntents.
CREATE INDEX IF NOT EXISTS idx_transactions_cargo
  ON payments.transactions (provider, charge_ref)
  WHERE charge_ref IS NOT NULL;

-- ── El motivo del descuento al chofer ───────────────────────────────────────
--
-- Una parte del reparto puede llevar un descuento (penalidades por soltar
-- reservas). Guardar el importe sin el motivo deja un número que nadie puede
-- explicar seis meses después.
ALTER TABLE payments.splits
  ADD COLUMN IF NOT EXISTS deduction_cents INTEGER NOT NULL DEFAULT 0
    CHECK (deduction_cents >= 0),
  ADD COLUMN IF NOT EXISTS memo TEXT;

-- ── Asientos idempotentes ───────────────────────────────────────────────────
--
-- El libro contable es de sólo inserción, y eso choca con los reintentos: si el
-- reparto se vuelve a pedir, los asientos se duplicarían y el cuadre diría que
-- entró el doble. La clave le da identidad a cada asiento lógico, y el índice
-- único hace que el segundo intento no escriba nada.
ALTER TABLE payments.ledger_entries
  ADD COLUMN IF NOT EXISTS entry_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_entry_key
  ON payments.ledger_entries (entry_key)
  WHERE entry_key IS NOT NULL;
