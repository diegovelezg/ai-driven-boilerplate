-- Brief del SECTOR por vertical (Fase A del perfilador). Una fila por vertical:
-- se investiga una vez y se reusa entre tenants (prior compartido).
-- El perfil del tenant (store_profiles) guarda solo los deltas + referencia.
create table vertical_profiles (
  id uuid primary key default gen_random_uuid(),
  taxonomy_id text unique,               -- nodo Shopify (null = vertical sin mapeo)
  vertical_detected text not null,       -- palabras del agente ("publicidad en vía pública")
  brief_json jsonb not null,             -- VerticalBrief (personas, ciclo, ticket, drivers, gaps)
  sources_json jsonb not null default '[]',
  confidence text,                       -- alta|media|baja del brief
  researched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index vertical_profiles_vertical_idx on vertical_profiles (vertical_detected);

create trigger vertical_profiles_updated_at
  before update on vertical_profiles
  for each row execute function set_updated_at();

alter table vertical_profiles enable row level security;
