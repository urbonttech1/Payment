-- ── La configuración que se edita desde el panel ────────────────────────────
--
-- Hasta ahora el procesador por defecto venía de una variable de entorno, así
-- que cambiarlo obligaba a redesplegar. Vive aquí, y el entorno se queda como
-- valor inicial y como respaldo: sin fila, manda lo que diga el entorno, que es
-- exactamente el comportamiento de antes.
--
-- Quién lo cambió y cuándo van en la propia fila. No es un lujo: cambiar el
-- procesador de los cobros nuevos es la decisión más consecuente que se puede
-- tomar desde un panel, y seis meses después alguien va a preguntar.
CREATE TABLE IF NOT EXISTS payments.settings (
  key        TEXT        PRIMARY KEY,
  value      JSONB       NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
