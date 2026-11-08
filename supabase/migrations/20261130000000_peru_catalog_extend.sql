-- Catálogo Perú: extender modelo para no perder datos valiosos del CSV.
-- IDs propios (gen_random_uuid); external_id del CSV solo vive en external_ref.
-- Toda screen queda atada a empresa proveedora (paridad venues: supplier exige FK).

-- 1. Proveedor obligatorio si ownership='supplier' también en screens (venues ya lo tiene).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'screens_supplier_check') then
    alter table inv_screens
      add constraint screens_supplier_check
      check (ownership <> 'supplier' or supplier_company_id is not null);
  end if;
end $$;

-- 2. Venues: granularidad de dirección del catálogo.
alter table inv_venues
  add column if not exists district text,
  add column if not exists region text,
  add column if not exists postal_code text,
  add column if not exists full_address text;

-- 3. Screens: medidas físicas + comercial + enriquecimiento. Todo nullable;
--    source_attrs guarda la fila cruda completa (cero pérdida) y el embedding
--    vive en tabla aparte para no engordar el core.
alter table inv_screens
  add column if not exists width_m numeric,
  add column if not exists height_m numeric,
  add column if not exists price_pen numeric,
  add column if not exists currency text not null default 'PEN',
  add column if not exists impact_day int,
  add column if not exists impressions_day int,
  add column if not exists duration_sec int,
  add column if not exists views_per_spot int,
  add column if not exists effective_daily_views int,
  add column if not exists restrictions text,
  add column if not exists url text,
  add column if not exists description text,
  add column if not exists sales_pitch text,
  add column if not exists audience_target text,
  add column if not exists tags text[],
  add column if not exists score numeric,
  add column if not exists traffic_mobility_score int,
  add column if not exists commercial_intensity_score int,
  add column if not exists vehicular_pct int,
  add column if not exists pedestrian_pct int,
  add column if not exists geo_daily_life numeric,
  add column if not exists geo_travel_transit numeric,
  add column if not exists geo_gen_z_lifestyle numeric,
  add column if not exists geo_health_wellness numeric,
  add column if not exists geo_high_end_luxury numeric,
  add column if not exists geo_business_executive numeric,
  add column if not exists suggested_local_businesses text,
  add column if not exists landuse_zones text,
  add column if not exists building_types text,
  add column if not exists pois_anchors text,
  add column if not exists pois_anchors_count int,
  add column if not exists pois_total_count int,
  add column if not exists pois_list_json jsonb not null default '[]',
  add column if not exists road_tier_label text,
  add column if not exists congestion_level text,
  add column if not exists average_speed_kmh numeric,
  add column if not exists is_major_corridor boolean,
  add column if not exists primary_road_class text,
  add column if not exists road_classes_detected text,
  add column if not exists media_images text[] not null default '{}',
  add column if not exists source_attrs jsonb not null default '{}';

-- 4. Embeddings semánticos (768d, gemini-embedding-001) en tabla aparte.
create extension if not exists vector;

create table if not exists inv_screen_embeddings (
  screen_id uuid primary key references inv_screens (id) on delete cascade,
  store_id uuid not null references sys_stores (id) on delete cascade,
  embedding vector(768),
  model text,
  created_at timestamptz not null default now()
);
create index if not exists inv_screen_embeddings_store_idx on inv_screen_embeddings (store_id);

alter table inv_screen_embeddings enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'tenant_isolation' and tablename = 'inv_screen_embeddings') then
    create policy tenant_isolation on inv_screen_embeddings
      for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
  end if;
end $$;
