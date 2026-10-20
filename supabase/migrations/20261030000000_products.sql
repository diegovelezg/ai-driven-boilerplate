-- Catálogo canónico por tenant (Fase product-intel, paso 1).
-- Upsert-only desde Medusa/Shopify: nunca se borra, el sync solo actualiza
-- platform_status + variants_json. El estado EFECTIVO (is_active) lo decide el
-- trigger: override manual ?? plataforma. Así "definir e ir actualizando" no
-- requiere gestión completa y el sync jamás pisa lo manual.
create table products (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  source text not null,               -- medusa_product | shopify_product | local
  source_id text,                     -- prod_xxx / gid://... (null = solo local)
  title text not null,
  handle text,
  platform_status text,               -- crudo: published/draft/proposed/rejected/active/...
  is_active_override boolean,         -- set manual desde UI (null = sigue plataforma)
  is_active boolean not null default true, -- efectivo para el engine (lo escribe el trigger)
  variants_json jsonb not null default '[]', -- [{sku,title,quantity,unit_price}]
  metadata jsonb,                     -- crudo extra (tags, collection, etc.)
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, source, source_id)
);
create index products_store_active_idx on products (store_id, is_active);
create index products_store_title_idx on products (store_id, title);

-- updated_at automático (mismo patrón que customers).
create trigger products_updated_at
  before update on products
  for each row execute function set_updated_at();

-- Estado efectivo: override manual gana; sin override, solo los estados
-- explícitamente inactivos apagan (desconocido = activo, fail-open).
create or replace function set_product_is_active()
returns trigger language plpgsql as $$
begin
  new.is_active := coalesce(
    new.is_active_override,
    not (lower(coalesce(new.platform_status, '')) in (
      'draft', 'proposed', 'rejected', 'inactive',
      'archived', 'disabled', 'deleted'
    ))
  );
  return new;
end $$;
create trigger products_is_active
  before insert or update of platform_status, is_active_override on products
  for each row execute function set_product_is_active();

alter table products enable row level security;
create policy tenant_isolation on products
  for all to authenticated
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));
