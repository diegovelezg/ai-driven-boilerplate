-- Flujo DOOH desde Orden de Inserción (etapas 4-9).
-- Entrada única: insertion_orders (IO / Nota de Pedido). Etapas 1-3
-- (prospección/brief/soft_hold) fuera de alcance: no se crean tablas de
-- propuestas ni holds temporales.
-- Mapa:
--   4. Contrato      -> insertion_orders + insertion_order_lines (signed)
--   5. Hard hold     -> bookings(status confirmed/active) + trigger anti-sobreventa
--   6. Autorización  -> agency_orders (OM/OC de la agencia)
--   7. Operación     -> creatives (ingesta + QC + aprobación legal)
--   8. Emisión       -> bookings vinculados al CMS (player/play-out vive fuera)
--   9. Certificación -> photo_checks (foto check) + play_logs (PoP crudo)
--   9. Cobranza      -> invoices (A/R referenciando OM/OC + PoP)

-- 4. IO: numeración única por tenant, anunciante vs razón a facturar (agencia).
create table insertion_orders (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  io_number text not null check (char_length(btrim(io_number)) > 0),
  advertiser_company_id uuid references companies (id) on delete set null,
  billing_company_id uuid references companies (id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'signed', 'cancelled')),
  starts_at date,
  ends_at date,
  payment_terms text, -- ej. 45 días
  service_clauses text,
  signed_by_agency text,
  signed_by_company text,
  signed_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at >= starts_at),
  check (status <> 'signed' or signed_at is not null)
);
create unique index insertion_orders_store_number_uidx on insertion_orders (store_id, io_number);
create index insertion_orders_store_status_idx on insertion_orders (store_id, status);
create index insertion_orders_store_advertiser_idx on insertion_orders (store_id, advertiser_company_id);

-- 4b. Líneas de la IO: pantallas + slots + periodo + tarifa.
create table insertion_order_lines (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  io_id uuid not null references insertion_orders (id) on delete cascade,
  screen_id uuid not null references screens (id) on delete restrict,
  slot_id uuid references inventory_slots (id) on delete restrict,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  rate_minor int check (rate_minor is null or rate_minor >= 0),
  notes text,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index insertion_order_lines_io_idx on insertion_order_lines (io_id);
create index insertion_order_lines_store_screen_idx on insertion_order_lines (store_id, screen_id);

-- Vínculo campaña <-> IO (campaigns ya existe como venta generada en el sistema).
alter table campaigns add column if not exists insertion_order_id uuid references insertion_orders (id) on delete set null;
create unique index if not exists campaigns_io_uidx on campaigns (insertion_order_id) where insertion_order_id is not null;
create index if not exists campaigns_store_io_idx on campaigns (store_id, insertion_order_id);

-- 5. Hard hold: bookings materializa la ocupación. Se añade referencia a la IO.
alter table bookings add column if not exists insertion_order_id uuid references insertion_orders (id) on delete set null;
create index if not exists bookings_store_io_idx on bookings (store_id, insertion_order_id);
create index if not exists bookings_io_slot_idx on bookings (insertion_order_id, slot_id);

-- Anti-sobreventa: un confirmed/active bloquea cualquier otro booking no cancelado
-- en el mismo slot con periodo solapado. Los 'hold' legacy no bloquean entre sí
-- (etapas 1-3 fuera de alcance), pero un hard sí pisa holds.
create or replace function check_hard_hold_overlap() returns trigger as $$
begin
  if new.status in ('confirmed', 'active') then
    if exists (
      select 1 from bookings b
      where b.slot_id = new.slot_id
        and b.id is distinct from new.id
        and b.status in ('confirmed', 'active')
        and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(new.starts_at, new.ends_at, '[)')
    ) then
      raise exception 'hard_hold overlap: slot % ocupado en [% , %)', new.slot_id, new.starts_at, new.ends_at;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists bookings_hard_hold_overlap on bookings;
create trigger bookings_hard_hold_overlap
  before insert or update on bookings
  for each row execute function check_hard_hold_overlap();

-- 6. Autorización de la agencia: OM/OC que habilita facturación.
create table agency_orders (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  io_id uuid not null references insertion_orders (id) on delete cascade,
  kind text not null check (kind in ('OM', 'OC')),
  code text not null check (char_length(btrim(code)) > 0),
  portal text, -- OMNET | Coupa | SAP | otro
  issued_at date,
  document_url text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index agency_orders_store_kind_code_uidx on agency_orders (store_id, kind, code);
create index agency_orders_io_idx on agency_orders (io_id);

-- 7. Materiales + QC por pantalla (specs estrictas + aprobación legal/marca).
create table creatives (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  io_id uuid not null references insertion_orders (id) on delete cascade,
  name text not null check (char_length(btrim(name)) > 0),
  file_url text,
  width_px int check (width_px is null or width_px > 0),
  height_px int check (height_px is null or height_px > 0),
  aspect text, -- ej. 16:9, 9:16
  container text, -- ej. .MP4
  codec text, -- ej. H.264
  fps numeric check (fps is null or fps > 0),
  bitrate_kbps int check (bitrate_kbps is null or bitrate_kbps > 0),
  duration_s numeric(6,2) check (duration_s is null or duration_s > 0), -- ej. 10.00
  material_deadline date,
  qc_status text not null default 'pending' check (qc_status in ('pending', 'approved', 'rejected')),
  qc_notes text,
  legal_status text not null default 'pending' check (legal_status in ('pending', 'approved', 'rejected')),
  legal_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index creatives_io_idx on creatives (io_id);
create index creatives_store_qc_idx on creatives (store_id, qc_status);

-- 9a. Foto check: sustento visual 2-3 primeros días.
create table photo_checks (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  io_id uuid not null references insertion_orders (id) on delete cascade,
  screen_id uuid references screens (id) on delete set null,
  taken_at timestamptz not null default now(),
  photo_url text,
  video_url text,
  notes text,
  created_at timestamptz not null default now(),
  check (photo_url is not null or video_url is not null)
);
create index photo_checks_io_idx on photo_checks (io_id, taken_at);

-- 9b. PoP crudo del CMS/AdServer: una fila por emisión certificada.
create table play_logs (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  io_id uuid references insertion_orders (id) on delete set null,
  screen_id uuid references screens (id) on delete set null,
  slot_id uuid references inventory_slots (id) on delete set null,
  played_at timestamptz not null,
  duration_s numeric(6,2) check (duration_s is null or duration_s > 0),
  error_code text, -- null = emisión OK; ej. power_cut | link_down
  source text, -- broadsign | vistar | cms | manual
  raw_json jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index play_logs_store_io_time_idx on play_logs (store_id, io_id, played_at);
create index play_logs_screen_time_idx on play_logs (screen_id, played_at);

-- 9c. Factura electrónica (A/R) referenciando OM/OC + PoP.
create table invoices (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  io_id uuid references insertion_orders (id) on delete set null,
  number text not null check (char_length(btrim(number)) > 0),
  amount_minor int not null check (amount_minor >= 0),
  currency text not null default 'PEN',
  issue_date date,
  due_date date,
  status text not null default 'draft' check (status in ('draft', 'issued', 'paid', 'overdue', 'cancelled')),
  om_ref text, -- código OM/OC de agency_orders.code
  pop_report_url text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (due_date is null or issue_date is null or due_date >= issue_date)
);
create unique index invoices_store_number_uidx on invoices (store_id, number);
create index invoices_store_status_idx on invoices (store_id, status);
create index invoices_io_idx on invoices (io_id);

create trigger insertion_orders_updated_at before update on insertion_orders for each row execute function set_updated_at();
create trigger agency_orders_updated_at before update on agency_orders for each row execute function set_updated_at();
create trigger creatives_updated_at before update on creatives for each row execute function set_updated_at();
create trigger invoices_updated_at before update on invoices for each row execute function set_updated_at();

alter table insertion_orders enable row level security;
alter table insertion_order_lines enable row level security;
alter table agency_orders enable row level security;
alter table creatives enable row level security;
alter table photo_checks enable row level security;
alter table play_logs enable row level security;
alter table invoices enable row level security;

create policy tenant_isolation on insertion_orders for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy tenant_isolation on insertion_order_lines for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy tenant_isolation on agency_orders for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy tenant_isolation on creatives for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy tenant_isolation on photo_checks for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy tenant_isolation on play_logs for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy tenant_isolation on invoices for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
