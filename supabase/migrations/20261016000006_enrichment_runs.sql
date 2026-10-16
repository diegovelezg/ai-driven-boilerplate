-- Estado de cada corrida de enriquecimiento (para background + UI de progreso).
-- El trabajo corre desacoplado de la request; el cliente lee esta tabla para el status.
create table enrichment_runs (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references stores (id) on delete cascade,
  status      text not null default 'running'
    check (status in ('running', 'done', 'error')),
  total       int not null default 0,
  processed   int not null default 0,
  failed      int not null default 0,
  current     text,                 -- dominio en curso
  error       text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);

alter table enrichment_runs enable row level security;
create index enrichment_runs_store_started_idx
  on enrichment_runs (store_id, started_at desc);
