-- Pivote DOOH: gestión comercial de espacios publicitarios.
-- Retira dependencia de Medusa/Shopify (tablas stores/channels/market_regions/
-- products/orders quedan legacy, no se borran). Nueva fuente de verdad:
--   companies (cliente/proveedor, ya existe) + contacts (ya existe)
--   venues -> screens -> loop_templates -> inventory_slots -> campaigns/bookings
-- Inspiración: jerarquía Network/Publisher -> Venue -> Screen -> Loop -> Slot -> Booking
-- (Broadsign/Vistar/Hivestack) + taxonomías OpenRTB 2.6 DOOH / DPAA / OpenOOH para
-- campos externos (venue_type, fixed/moving, dpi, w/h). OpenRTB solo rige la
-- comunicación programática; el calendario interno vive aquí.

-- 1. Venues: punto físico georreferenciado. ownership: own | supplier.
--    supplier_company_id -> companies (rol supplier) cuando es de proveedor.
create table venues (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  company_id uuid references companies (id) on delete set null, -- dueño interno (red propia)
  supplier_company_id uuid references companies (id) on delete set null, -- proveedor del espacio
  ownership text not null default 'own' check (ownership in ('own', 'supplier')),
  name text not null check (char_length(btrim(name)) > 0),
  venue_type text, -- taxonomía DPAA/OpenOOH: mall | transit | street_furniture | airport | retail | office | ...
  latitude numeric(9,6),
  longitude numeric(9,6),
  address text,
  city text,
  country text, -- ISO2
  timezone text, -- ej. America/Lima
  source text not null default 'sheet' check (source in ('sheet', 'csv', 'manual', 'legacy')),
  external_ref text, -- id/row del Sheet para idempotencia
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ownership <> 'supplier' or supplier_company_id is not null)
);
create index venues_store_idx on venues (store_id);
create index venues_store_type_idx on venues (store_id, venue_type);
create unique index venues_store_ref_uidx on venues (store_id, external_ref) where external_ref is not null;

-- 2. Screens / display_units: hardware físico.
create table screens (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  venue_id uuid not null references venues (id) on delete cascade,
  name text not null check (char_length(btrim(name)) > 0),
  ownership text not null default 'own' check (ownership in ('own', 'supplier')),
  supplier_company_id uuid references companies (id) on delete set null,
  -- OpenRTB DOOH: dimensiones físicas + píxeles + dpi
  width_px int check (width_px is null or width_px > 0),
  height_px int check (height_px is null or height_px > 0),
  dpi int check (dpi is null or dpi > 0),
  orientation text check (orientation is null or orientation in ('landscape', 'portrait', 'square')),
  technology text, -- LED | LCD | ...
  placement text check (placement is null or placement in ('fixed', 'moving')), -- fija vs transporte
  operating_hours jsonb not null default '{}', -- {mon:[["08:00","22:00"]],...}
  player_id text, -- identificador hardware/reproductor CMS
  is_active boolean not null default true,
  source text not null default 'sheet' check (source in ('sheet', 'csv', 'manual', 'legacy')),
  external_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index screens_store_venue_idx on screens (store_id, venue_id);
create index screens_store_active_idx on screens (store_id, is_active);
create unique index screens_store_ref_uidx on screens (store_id, external_ref) where external_ref is not null;

-- 3. Loop templates: estructura temporal recurrente (ej. bucle 60s, 6 slots de 10s).
create table loop_templates (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  name text not null check (char_length(btrim(name)) > 0),
  duration_ms int not null check (duration_ms > 0),
  max_slots int not null check (max_slots > 0),
  slot_duration_ms int not null check (slot_duration_ms > 0),
  created_at timestamptz not null default now(),
  check (duration_ms = max_slots * slot_duration_ms)
);
create index loop_templates_store_idx on loop_templates (store_id);

-- 4. Inventory slots: unidad mínima vendible dentro del loop.
create table inventory_slots (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  screen_id uuid not null references screens (id) on delete cascade,
  loop_template_id uuid references loop_templates (id) on delete set null,
  slot_index int not null check (slot_index >= 1),
  is_programmatic_allowed boolean not null default false,
  share_of_voice_target numeric(5,2), -- ej. 16.67 (% teórico del loop)
  is_active boolean not null default true,
  external_ref text,
  created_at timestamptz not null default now(),
  unique (screen_id, slot_index)
);
create index inventory_slots_store_screen_idx on inventory_slots (store_id, screen_id);
create unique index inventory_slots_store_ref_uidx on inventory_slots (store_id, external_ref) where external_ref is not null;

-- 5. Campaigns: ventas generadas EN el sistema (ya no se importan de Medusa/Shopify).
--    TBD comercial: esquema mínimo para reservar/facturar después.
create table campaigns (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  advertiser_company_id uuid references companies (id) on delete set null, -- cliente anunciante
  name text not null check (char_length(btrim(name)) > 0),
  status text not null default 'draft' check (status in ('draft', 'reserved', 'active', 'completed', 'cancelled')),
  starts_at date,
  ends_at date,
  budget_minor int, -- moneda de stores.shop_currency
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index campaigns_store_status_idx on campaigns (store_id, status);

-- 6. Bookings: ocupación de un slot por campaña en un periodo.
create table bookings (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  slot_id uuid not null references inventory_slots (id) on delete cascade,
  campaign_id uuid references campaigns (id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'hold' check (status in ('hold', 'confirmed', 'active', 'completed', 'cancelled')),
  check (ends_at > starts_at)
);
create index bookings_slot_period_idx on bookings (slot_id, starts_at, ends_at) where status <> 'cancelled';
create index bookings_store_period_idx on bookings (store_id, starts_at, ends_at);

-- 7. Import runs: auditoría de cada importación Sheet/CSV.
create table import_runs (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  kind text not null check (kind in ('companies', 'contacts', 'venues', 'screens', 'slots')),
  source text not null check (source in ('sheet', 'csv')),
  source_url text,
  rows_seen int not null default 0,
  rows_ok int not null default 0,
  rows_failed int not null default 0,
  errors_json jsonb not null default '[]',
  created_at timestamptz not null default now()
);
create index import_runs_store_idx on import_runs (store_id, created_at desc);

create trigger venues_updated_at before update on venues for each row execute function set_updated_at();
create trigger screens_updated_at before update on screens for each row execute function set_updated_at();
create trigger campaigns_updated_at before update on campaigns for each row execute function set_updated_at();

alter table venues enable row level security;
alter table screens enable row level security;
alter table loop_templates enable row level security;
alter table inventory_slots enable row level security;
alter table campaigns enable row level security;
alter table bookings enable row level security;
alter table import_runs enable row level security;

create policy tenant_isolation on venues for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy tenant_isolation on screens for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy tenant_isolation on loop_templates for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy tenant_isolation on inventory_slots for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy tenant_isolation on campaigns for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy tenant_isolation on bookings for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy tenant_isolation on import_runs for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
