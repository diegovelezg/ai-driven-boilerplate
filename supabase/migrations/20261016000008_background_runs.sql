-- Estado de cada proceso en segundo plano (enriquecimiento, sync, ...).
-- Única fuente de verdad para la cinta de progreso global de la UI.
-- Reemplaza a enrichment_runs: antes el progreso era específico de enriquecimiento.
create table background_runs (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references stores (id) on delete cascade,
  kind        text not null,                 -- 'enrichment' | 'sync'
  label       text not null,                 -- nombre visible: 'Enriquecimiento', 'Sincronización'
  status      text not null default 'running'
    check (status in ('running', 'done', 'error')),
  total       int not null default 0,
  processed   int not null default 0,
  failed      int not null default 0,
  current     text,                          -- unidad en curso (dominio, fase)
  summary     text,                          -- resumen final que muestra la cinta
  error       text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);

alter table background_runs enable row level security;
create index background_runs_store_started_idx
  on background_runs (store_id, started_at desc);

drop table if exists enrichment_runs;
