-- ── Las credenciales de cada procesador, cifradas ──────────────────────────
--
-- Hasta ahora venían de variables de entorno, así que añadir una pasarela era
-- tocar infraestructura y redesplegar. Aquí se pueden escribir desde el panel.
--
-- `secreto_cifrado` es un blob AES-256-GCM (ver `src/config/cifrado.ts`): con
-- la clave secreta de un procesador se mueve dinero, y esa fila acaba también
-- en cada copia de seguridad y en cada volcado que alguien se baja para
-- depurar. La clave maestra vive en el entorno, no aquí: quien vea la base se
-- lleva un bloque inútil.
--
-- `pista` son los últimos cuatro caracteres, lo único que el panel puede ver.
-- Sirve para reconocer cuál está puesta —y para notar que alguien subió la de
-- pruebas a producción— y no sirve para usarla.
CREATE TABLE IF NOT EXISTS payments.provider_credentials (
  provider        TEXT        PRIMARY KEY,
  secreto_cifrado TEXT        NOT NULL,
  pista           TEXT,
  estado          TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (estado IN ('pending','ok','invalid')),
  ultimo_error    TEXT,
  comprobada_en   TIMESTAMPTZ,
  updated_by      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
