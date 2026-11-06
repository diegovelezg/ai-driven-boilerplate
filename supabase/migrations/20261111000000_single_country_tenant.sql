-- Tenant single-país: cada tienda tiene UN solo país/región/moneda.
-- Retira el feature multiregión (market_regions + market_id + ?market=).
-- 1) stores.shop_country (ISO2, SSOT del país del tenant).
-- 2) Backfill desde market_regions (preferido: moneda == shop_currency).
-- 3) Drop columnas de partición + tabla market_regions.

-- 1) Columna país del tenant.
alter table stores add column if not exists shop_country text;

-- 2) Backfill: país implícito del market primario
-- (misma regla que implicit_market_country: countries=[XX] único, si no nombre ISO2).
-- Preferencia: market cuya currency == shop_currency, si no el primero por nombre.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'market_regions') THEN
    UPDATE stores s
    SET shop_country = sub.implicit_country
    FROM (
      SELECT DISTINCT ON (m.store_id)
        m.store_id,
        CASE
          WHEN array_length(m.countries, 1) = 1 AND upper(m.countries[1]) ~ '^[A-Z]{2}$'
            THEN upper(m.countries[1])
          WHEN m.name ~ '^[A-Za-z]{2}$' THEN upper(m.name)
          ELSE NULL
        END AS implicit_country,
        CASE WHEN upper(m.currency) = upper(s2.shop_currency) THEN 0 ELSE 1 END AS pref
      FROM market_regions m
      JOIN stores s2 ON s2.id = m.store_id
      ORDER BY m.store_id, pref, m.name
    ) sub
    WHERE s.id = sub.store_id
      AND s.shop_country IS NULL
      AND sub.implicit_country IS NOT NULL;

    -- Fallback por moneda (PEN->PE, MXN->MX, CLP->CL, COP->CO, ARS->AR,
    -- BRL->BR, USD->US, EUR->ES) cuando el market no declara país.
    UPDATE stores s
    SET shop_country = CASE upper(s.shop_currency)
      WHEN 'PEN' THEN 'PE'
      WHEN 'MXN' THEN 'MX'
      WHEN 'CLP' THEN 'CL'
      WHEN 'COP' THEN 'CO'
      WHEN 'ARS' THEN 'AR'
      WHEN 'BRL' THEN 'BR'
      WHEN 'USD' THEN 'US'
      WHEN 'EUR' THEN 'ES'
      ELSE NULL
    END
    WHERE s.shop_country IS NULL
      AND upper(s.shop_currency) IN ('PEN','MXN','CLP','COP','ARS','BRL','USD','EUR');
  END IF;
END $$;

-- 3a) tenant_model_params: de (store_id, market_id) a una fila por tienda.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tenant_model_params' AND column_name = 'market_id') THEN
    -- Si hay varias filas por tienda (una por market), conserva la más reciente.
    DELETE FROM tenant_model_params a
    USING tenant_model_params b
    WHERE a.store_id = b.store_id
      AND a.fitted_at < b.fitted_at;
    -- Segunda pasada por si empatan fitted_at (conserva una cualquiera).
    DELETE FROM tenant_model_params a
    USING tenant_model_params b
    WHERE a.store_id = b.store_id
      AND a.ctid < b.ctid;
    ALTER TABLE tenant_model_params DROP CONSTRAINT IF EXISTS tenant_model_params_store_market_uq;
    ALTER TABLE tenant_model_params DROP COLUMN IF EXISTS market_id;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_model_params_store_uq') THEN
      ALTER TABLE tenant_model_params ADD CONSTRAINT tenant_model_params_store_uq UNIQUE (store_id);
    END IF;
  END IF;
END $$;

-- 3b) customer_predictions: market_id era solo etiqueta de partición.
ALTER TABLE customer_predictions DROP COLUMN IF EXISTS market_id;
DROP INDEX IF EXISTS customer_predictions_store_market_asof_idx;

-- 3c) orders: quita FK + columna market_id (el país/moneda salen de stores).
DO $$
DECLARE r record;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'market_id') THEN
    FOR r IN
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'orders'::regclass AND confrelid = 'market_regions'::regclass
    LOOP
      EXECUTE format('ALTER TABLE orders DROP CONSTRAINT IF EXISTS %I', r.conname);
    END LOOP;
    ALTER TABLE orders DROP COLUMN IF EXISTS market_id;
  END IF;
END $$;

-- 3d) Columnas country solo para el filtro ?market=: ya no filtran nada.
-- customers.country y orders.country SE CONSERVAN (dato real del cliente/orden).
DROP INDEX IF EXISTS churn_signals_store_country_idx;
DROP INDEX IF EXISTS proposed_actions_store_country_idx;
DROP INDEX IF EXISTS proposed_leads_store_country_idx;
ALTER TABLE churn_signals DROP COLUMN IF EXISTS country;
ALTER TABLE proposed_actions DROP COLUMN IF EXISTS country;
ALTER TABLE proposed_leads DROP COLUMN IF EXISTS country;

-- 3e) Tabla de markets: fuera. (channels se conserva: es canal, no región.)
DROP TABLE IF EXISTS market_regions CASCADE;
