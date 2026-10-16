-- Fase 1: multi-tenant stores + canonical channel/market + customers + orders.
-- Moneda original por orden (nunca agregada entre monedas). Conversión RFM = Fase 2.

-- Stores = tenants (una fila por ecommerce conectado).
create table stores (
  id uuid primary key default gen_random_uuid(),
  merchant_id text,
  platform text not null,          -- medusa | shopify | woocommerce
  shop_url text not null,          -- clave canónica de conexión (normalizada, sin trailing slash)
  name text,
  shop_currency text not null default 'PEN',
  created_at timestamptz not null default now(),
  unique (platform, shop_url)
);

-- Canal de venta canónico: medusa sales_channel / shopify publication.
create table channels (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  source text not null,             -- medusa_sales_channel | shopify_channel
  source_id text not null,          -- sc_xxx / gid://shopify/Publication/...
  name text not null,
  unique (store_id, source, source_id)
);

-- Zona comercial canónica: medusa region / shopify market.
create table market_regions (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  source text not null,             -- medusa_region | shopify_market
  source_id text not null,          -- reg_xxx / gid://shopify/Market/...
  name text not null,
  currency text not null,           -- PEN, USD, MXN (eje confiable; countries suele venir vacío)
  countries text[] not null default '{}',
  unique (store_id, source, source_id)
);

-- Customers del tenant. Incluye ecommerce (upsert en sync) + locales (source='local', intactos).
create table customers (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  external_id text,                 -- Medusa/Shopify customer id (null = solo local)
  source text not null default 'ecommerce' check (source in ('ecommerce', 'local')),
  email text not null,
  phone text,
  first_name text,
  last_name text,
  company_name text,
  customer_type text not null default 'B2C',
  orders_count int not null default 0,
  total_spent bigint not null default 0,  -- minor units, moneda de `currency`
  currency text,                           -- moneda primaria (la de mayor gasto)
  external_created_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, external_id)
);
create index customers_store_email_idx on customers (store_id, email);

-- Orders con moneda original + FKs canónicos + país crudo.
create table orders (
  id uuid primary key default gen_random_uuid(),
  external_order_id text not null unique,
  store_id uuid not null references stores (id) on delete cascade,
  customer_id uuid not null references customers (id) on delete cascade,
  channel_id uuid references channels (id),
  market_id uuid references market_regions (id),
  total_amount bigint not null,      -- minor units, MONEDA ORIGINAL
  currency text not null,            -- moneda original
  country text,                      -- ISO2 shipping/billing, best-effort
  items_json jsonb not null default '[]',
  placed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (store_id, external_order_id)
);
create index orders_store_customer_idx on orders (store_id, customer_id);
create index orders_store_currency_idx on orders (store_id, currency);

-- updated_at automático en customers.
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;
create trigger customers_updated_at
  before update on customers
  for each row execute function set_updated_at();

-- RLS: todo denegado por defecto; el server usa service_role (bypass).
alter table stores enable row level security;
alter table channels enable row level security;
alter table market_regions enable row level security;
alter table customers enable row level security;
alter table orders enable row level security;
