-- Parámetros aprendidos del motor por tenant (issue #27 Paso 3).
-- Tres capas, frontera explícita:
--   Método (código): episodeize, mezcla EM, BIC, backtest. Nadie lo escribe en runtime.
--   Parámetros (esta tabla): episode_window_days, mezcla K+(peso,μ,σ) por
--     partición, ciclo/horizonte derivados. Solo los escribe el tune mensual
--     con backtest (Paso 4). NINGÚN parámetro se comparte entre tenants.
--   Arranque en frío: prior por arquetipo (código); sin fila aquí el motor
--     usa el comportamiento actual (sin episodios extra, grilla única).
-- Una fila vigente por (tienda, partición): market_id null = global del tenant.
-- Sin FK a market_regions (como customer_predictions.market_id) para no
-- bloquear backfill cuando los markets aún no están sincronizados.
create table if not exists tenant_model_params (
  store_id uuid not null references stores (id) on delete cascade,
  market_id uuid,
  version text not null,
  params_json jsonb not null,
  fitted_at timestamptz not null default now(),
  samples int check (samples is null or samples >= 0),
  events int check (events is null or events >= 0),
  backtest_json jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  -- Vigencia única por partición con NULLS NOT DISTINCT (market null = global,
  -- una sola fila). Es CONSTRAINT (no índice de expresión) para que el
  -- escritor del Paso 4 haga upsert directo con onConflict "store_id,market_id".
  constraint tenant_model_params_store_market_uq
    unique nulls not distinct (store_id, market_id)
);
-- Limpieza idempotente si se aplicó una versión previa del worktree (índice
-- de expresión con coalesce): el constraint de arriba lo reemplaza.
drop index if exists tenant_model_params_store_market_idx;
-- Por si la tabla ya existía sin el constraint (versión previa del worktree).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_model_params_store_market_uq'
  ) THEN
    ALTER TABLE tenant_model_params
      ADD CONSTRAINT tenant_model_params_store_market_uq
      UNIQUE NULLS NOT DISTINCT (store_id, market_id);
  END IF;
END $$;
create index if not exists tenant_model_params_store_fitted_idx
  on tenant_model_params (store_id, fitted_at desc);

-- updated_at automático (patrón del repo: set_updated_at()).
drop trigger if exists tenant_model_params_updated_at on tenant_model_params;
create trigger tenant_model_params_updated_at
  before update on tenant_model_params
  for each row execute function set_updated_at();

alter table tenant_model_params enable row level security;

drop policy if exists tenant_isolation on tenant_model_params;
create policy tenant_isolation on tenant_model_params
  for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
