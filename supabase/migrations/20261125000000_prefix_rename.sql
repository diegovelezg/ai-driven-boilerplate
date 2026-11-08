-- Renombres con prefijo por dominio (review profundo 2026-11).
-- sys_ = sistema/tenant · io_ = flujo orden→cobro · inv_ = inventario
-- crm_ = base comercial · ai_ = IA/metering.
-- Las policies históricas (tenant_isolation) y FKs referencian por OID y
-- siguen válidas tras el rename. Los cuerpos de funciones se recrean con
-- los nombres nuevos porque resuelven tablas por nombre en ejecución.
-- is_store_member / my_store_role CONSERVAN su nombre: 30+ policies
-- históricas los invocan; solo se actualiza su cuerpo a sys_memberships.

-- 1. Tablas -------------------------------------------------------------
alter table stores rename to sys_stores;
alter table merchant_users rename to sys_memberships;
alter table store_profiles rename to sys_store_profiles;
alter table store_secrets rename to sys_secrets;
alter table store_secret_audits rename to sys_secret_audits;
alter table background_runs rename to sys_runs;
alter table order_counters rename to io_counters;

alter table insertion_orders rename to io_orders;
alter table insertion_order_lines rename to io_lines;
alter table agency_orders rename to io_agency_orders;
alter table creatives rename to io_creatives;
alter table photo_checks rename to io_photo_checks;
alter table play_logs rename to io_play_logs;
alter table invoices rename to io_invoices;
alter table campaigns rename to io_campaigns;

alter table venues rename to inv_venues;
alter table screens rename to inv_screens;
alter table loop_templates rename to inv_loop_templates;
alter table inventory_slots rename to inv_slots;
alter table bookings rename to inv_bookings;

alter table companies rename to crm_companies;
alter table contacts rename to crm_contacts;

alter table llm_usage rename to ai_llm_usage;
alter table vertical_profiles rename to ai_vertical_profiles;
alter table domains rename to ai_domain_cache;

-- 2. View de metering ----------------------------------------------------
drop view if exists llm_usage_daily;
create or replace view ai_llm_usage_daily as
select
  store_id,
  date_trunc('day', created_at)::date as day,
  process,
  provider,
  model,
  count(*) as calls,
  sum(prompt_tokens) as prompt_tokens,
  sum(completion_tokens) as completion_tokens,
  sum(total_tokens) as total_tokens
from ai_llm_usage
group by 1, 2, 3, 4, 5;

-- 3. Funciones: cuerpos actualizados a los nombres nuevos ----------------
create or replace function public.is_store_member(sid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from sys_memberships
    where store_id = sid and user_id = auth.uid()
  )
$$;

create or replace function public.my_store_role(sid uuid)
returns text language sql stable security definer set search_path = public as $$
  select role from sys_memberships
  where store_id = sid and user_id = auth.uid()
  limit 1
$$;

drop function if exists public.start_run_if_free(uuid, text, text, int);
create or replace function public.sys_run_start(
  p_store_id uuid,
  p_kind text,
  p_label text,
  p_total int default 0
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- Serializa check+insert entre réplicas (se libera al commit).
  perform pg_advisory_xact_lock(hashtext('run-slot:' || p_store_id::text));

  if exists (
    select 1 from sys_runs r
    where r.store_id = p_store_id
      and r.status = 'running'
      and (
        p_kind = 'sync' or r.kind = 'sync'
        or r.kind = p_kind
        or (p_kind in ('scout', 'strategist', 'copywriter')
            and r.kind in ('scout', 'strategist', 'copywriter'))
        or (p_kind = 'copywriter' and r.kind in ('copywriter_single', 'regenerate'))
        or (p_kind in ('copywriter_single', 'regenerate') and r.kind = 'copywriter')
        or (p_kind = 'regenerate' and r.kind in ('regenerate', 'copywriter_single'))
        or (p_kind = 'copywriter_single' and r.kind = 'regenerate')
        or (p_kind = 'enrichment' and r.kind = 'enrich_single')
        or (p_kind = 'enrich_single' and r.kind = 'enrichment')
      )
  ) then
    return null;
  end if;

  insert into sys_runs (store_id, kind, label, total, status, scope_kind, scope_id)
  values (p_store_id, p_kind, p_label, p_total, 'running', 'global', null)
  returning id into v_id;

  return v_id;
exception when undefined_column then
  -- DB sin migración de scopes (20261021000000): reintenta legacy.
  insert into sys_runs (store_id, kind, label, total, status)
  values (p_store_id, p_kind, p_label, p_total, 'running')
  returning id into v_id;
  return v_id;
end;
$$;

-- Solo service_role (worker + server actions): ejecutable por PUBLIC sería
-- ocupable por cualquier authenticated (DoS del slot).
revoke all on function public.sys_run_start(uuid, text, text, int) from public, anon, authenticated;
grant execute on function public.sys_run_start(uuid, text, text, int) to service_role;

drop function if exists mint_io_number(uuid);
create or replace function io_mint_number(p_store uuid) returns text as $$
declare
  y int := extract(year from (now() at time zone 'America/Lima'))::int;
  n int;
  pfx text;
begin
  insert into io_counters (store_id, year, last_n)
  values (p_store, y, 1)
  on conflict (store_id, year)
  do update set last_n = io_counters.last_n + 1
  returning last_n into n;

  select io_prefix into pfx from sys_stores where id = p_store;
  if pfx is null then pfx := 'OI'; end if;
  return pfx || '-' || y || '-' || lpad(n::text, 4, '0');
end;
$$ language plpgsql security definer
set search_path = public;

drop function if exists check_hard_hold_overlap() cascade;
create or replace function io_check_hold_overlap() returns trigger as $$
begin
  if new.status in ('confirmed', 'active') then
    if exists (
      select 1 from inv_bookings b
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

alter function set_updated_at() rename to sys_set_updated_at;

-- 4. Triggers: nombres alineados al prefijo --------------------------------
drop trigger if exists agency_orders_updated_at on io_agency_orders;
create trigger io_agency_orders_updated_at before update on io_agency_orders for each row execute function sys_set_updated_at();
drop trigger if exists campaigns_updated_at on io_campaigns;
create trigger io_campaigns_updated_at before update on io_campaigns for each row execute function sys_set_updated_at();
drop trigger if exists companies_updated_at on crm_companies;
create trigger crm_companies_updated_at before update on crm_companies for each row execute function sys_set_updated_at();
drop trigger if exists contacts_updated_at on crm_contacts;
create trigger crm_contacts_updated_at before update on crm_contacts for each row execute function sys_set_updated_at();
drop trigger if exists creatives_updated_at on io_creatives;
create trigger io_creatives_updated_at before update on io_creatives for each row execute function sys_set_updated_at();
drop trigger if exists insertion_orders_updated_at on io_orders;
create trigger io_orders_updated_at before update on io_orders for each row execute function sys_set_updated_at();
drop trigger if exists invoices_updated_at on io_invoices;
create trigger io_invoices_updated_at before update on io_invoices for each row execute function sys_set_updated_at();
drop trigger if exists screens_updated_at on inv_screens;
create trigger inv_screens_updated_at before update on inv_screens for each row execute function sys_set_updated_at();
drop trigger if exists store_profiles_updated_at on sys_store_profiles;
create trigger sys_store_profiles_updated_at before update on sys_store_profiles for each row execute function sys_set_updated_at();
drop trigger if exists venues_updated_at on inv_venues;
create trigger inv_venues_updated_at before update on inv_venues for each row execute function sys_set_updated_at();
drop trigger if exists vertical_profiles_updated_at on ai_vertical_profiles;
create trigger ai_vertical_profiles_updated_at before update on ai_vertical_profiles for each row execute function sys_set_updated_at();
drop trigger if exists bookings_hard_hold_overlap on inv_bookings;
create trigger inv_bookings_hard_hold_overlap
  before insert or update on inv_bookings
  for each row execute function io_check_hold_overlap();
