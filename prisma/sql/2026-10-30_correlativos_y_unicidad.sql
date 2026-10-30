-- Aplicar ANTES de desplegar este cambio. `prisma db push` no agrega un UNIQUE sin
-- --accept-data-loss, y el pre-deploy de Railway fallaría. Con esto aplicado no ve diferencias.
BEGIN;

ALTER TABLE dtes_emitidos ADD COLUMN IF NOT EXISTS ambiente VARCHAR(2) NOT NULL DEFAULT '00';

ALTER TABLE dtes_emitidos DROP CONSTRAINT IF EXISTS dtes_emitidos_numero_control_key;
DROP INDEX IF EXISTS dtes_emitidos_numero_control_key;

CREATE UNIQUE INDEX IF NOT EXISTS dtes_emitidos_emisor_id_ambiente_numero_control_key
  ON dtes_emitidos (emisor_id, ambiente, numero_control);

CREATE INDEX IF NOT EXISTS dtes_emitidos_emisor_id_estado_idx
  ON dtes_emitidos (emisor_id, estado);

CREATE TABLE IF NOT EXISTS correlativos (
  emisor_id             INTEGER     NOT NULL,
  ambiente              VARCHAR(2)  NOT NULL,
  tipo_dte              VARCHAR(2)  NOT NULL,
  establecimiento_punto VARCHAR(8)  NOT NULL,
  ultimo                BIGINT      NOT NULL,
  CONSTRAINT correlativos_pkey PRIMARY KEY (emisor_id, ambiente, tipo_dte, establecimiento_punto),
  CONSTRAINT correlativos_emisor_id_fkey FOREIGN KEY (emisor_id)
    REFERENCES emisores (id) ON DELETE NO ACTION ON UPDATE NO ACTION
);

COMMIT;
