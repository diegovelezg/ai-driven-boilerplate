-- Ventas por producto y moneda (Fase product-intel, paso 2).
-- Una fila por (producto, moneda): nunca se mezcla PEN+MXN. Lo recalcula el
-- sync (determinista, sin LLM) desde orders.items_json; el trigger de products
-- sigue siendo dueño de is_active. Sin ventas = sin fila (no ceros).
create table product_stats (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  product_id uuid not null references products (id) on delete cascade,
  currency text not null,
  qty_all bigint not null default 0,
  qty_30d bigint not null default 0,
  qty_90d bigint not null default 0,
  revenue_all bigint not null default 0, -- minor units, MONEDA ORIGINAL
  revenue_30d bigint not null default 0,
  buyers_all int not null default 0,     -- customers distintos
  last_sold_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (product_id, currency)
);
create index product_stats_store_idx on product_stats (store_id, currency, revenue_all desc);

create trigger product_stats_updated_at
  before update on product_stats
  for each row execute function set_updated_at();

alter table product_stats enable row level security;
create policy tenant_isolation on product_stats
  for all to authenticated
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));
