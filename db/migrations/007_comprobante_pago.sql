-- ════════════════════════════════════════════════════════════════════════════
--  El comprobante del pago manual
--
--  Quien paga sube un documento —el justificante de la transferencia— y al
--  chofer le llega por correo. Se guarda la RUTA en el almacenamiento, no el
--  archivo: un PDF dentro de la base de pagos engorda cada copia de seguridad
--  y no se puede servir con un enlace firmado que caduque.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE payments.payouts
  ADD COLUMN IF NOT EXISTS document_path TEXT;
