-- ════════════════════════════════════════════════════════════════════════════
--  Cuál es la tarjeta principal de cada pasajero
--
--  Hasta ahora mandaba la primera que devolviera el procesador, que es un
--  orden que no controlamos: con dos tarjetas, el pasajero no podía elegir con
--  cuál se le cobra.
--
--  Vive aquí y no en el procesador a propósito. Square no tiene concepto de
--  tarjeta por defecto, y Stripe sí —`invoice_settings.default_payment_method`—
--  pero guardarlo en uno de los dos significaría que la preferencia se pierde
--  al cambiar de pasarela. Es una decisión de URBONT sobre su pasajero, no un
--  dato del procesador.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS payments.preferred_cards (
  payer_id    UUID        PRIMARY KEY,
  -- Qué procesador la guardó. Una tarjeta pertenece al que la guardó, así que
  -- la preferencia sólo vale mientras ese siga siendo el que cobra.
  provider    TEXT        NOT NULL,
  card_ref    TEXT        NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Para poder limpiar las preferencias de un procesador que se retira.
CREATE INDEX IF NOT EXISTS idx_preferred_cards_proveedor
  ON payments.preferred_cards (provider);
