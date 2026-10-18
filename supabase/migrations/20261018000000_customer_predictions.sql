-- Predicciones del motor probabilístico de recompra (issue #5).
-- Una fila por (tienda, cliente, fecha de corte, versión del modelo).
-- RLS activa; el server usa service_role (bypass), igual que retention_loop.
create table customer_predictions (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  customer_id uuid not null references customers (id) on delete cascade,
  as_of timestamptz not null,
  model_version text not null,        -- 'retention:v1'
  model text not null check (model in ('renovacion','segunda_compra')),
  p_recompra_h float,
  p_low float,
  p_high float,
  horizon_days int not null,
  expected_days float,
  p25_days float,
  p75_days float,
  ticket_esperado_minor bigint,
  valor_esperado_minor bigint,
  currency text,
  decision text not null check (decision in ('actuar','vigilar','organico','dormido','sin_canal','contactado_reciente','revision_humana')),
  confidence text not null check (confidence in ('alta','media','baja')),
  evidence_json jsonb not null default '{}',  -- {gaps, t_days, cycle_days, cycle_source, generator}
  created_at timestamptz not null default now(),
  unique (store_id, customer_id, as_of, model_version)
);

alter table customer_predictions enable row level security;
create index customer_predictions_store_asof_idx
  on customer_predictions (store_id, as_of desc);
create index customer_predictions_store_decision_idx
  on customer_predictions (store_id, decision);
