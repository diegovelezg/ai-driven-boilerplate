-- Alias de fusión de customers: el external_id combinado apunta a su canónico.
-- El sync respeta estos alias (omite los combinados y reasigna sus órdenes),
-- así la fusión sobrevive a los re-sync desde Medusa.
create table customer_aliases (
  store_id              uuid not null references stores (id) on delete cascade,
  merged_external_id    text not null,
  canonical_external_id text not null,
  created_at            timestamptz not null default now(),
  primary key (store_id, merged_external_id)
);

alter table customer_aliases enable row level security;
