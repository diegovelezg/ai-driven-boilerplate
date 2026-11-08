-- Renombres con prefijo por dominio (review profundo 2026-11).
-- sys_ = sistema/tenant · io_ = flujo orden→cobro · inv_ = inventario
-- crm_ = base comercial · ai_ = IA/metering.
-- Las policies históricas (tenant_isolation) y FKs referencian por OID y
-- siguen válidas tras el rename. Los cuerpos de funciones se recrean con
-- los nombres nuevos porque resuelven tablas por nombre en ejecución.
-- is_store_member / my_store_role CONSERVAN su nombre: 30+ policies
-- históricas los invocan; solo se actualiza su cuerpo a sys_memberships.

-- 1. Tablas -------------------------------------------------------------
-- Renombres idempotentes: en replay fresco el origen existe y el destino no
-- (renombra); en entornos que ya aplicaron el prefijo por otra vía se salta
-- sin fallar (origen ausente, destino presente).
do $$
declare
  r record;
begin
  for r in select * from (values
    ('stores', 'sys_stores'),
    ('merchant_users', 'sys_memberships'),
    ('store_profiles', 'sys_store_profiles'),
    ('store_secrets', 'sys_secrets'),
    ('store_secret_audits', 'sys_secret_audits'),
    ('background_runs', 'sys_runs'),
    ('order_counters', 'io_counters'),
    ('insertion_orders', 'io_orders'),
    ('insertion_order_lines', 'io_lines'),
    ('agency_orders', 'io_agency_orders'),
    ('creatives', 'io_creatives'),
    ('photo_checks', 'io_photo_checks'),
    ('play_logs', 'io_play_logs'),
    ('invoices', 'io_invoices'),
    ('campaigns', 'io_campaigns'),
    ('venues', 'inv_venues'),
    ('screens', 'inv_screens'),
    ('loop_templates', 'inv_loop_templates'),
    ('inventory_slots', 'inv_slots'),
    ('bookings', 'inv_bookings'),
    ('companies', 'crm_companies'),
    ('contacts', 'crm_contacts'),
    ('llm_usage', 'ai_llm_usage'),
    ('vertical_profiles', 'ai_vertical_profiles'),
    ('domains', 'ai_domain_cache')
  ) as v(old_name, new_name)
  loop
    if to_regclass('public.' || r.old_name) is not null
      and to_regclass('public.' || r.new_name) is null then
      execute format('alter table public.%I rename to %I', r.old_name, r.new_name);
    end if;
  end loop;
end $$;

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

-- Idempotente: en entornos ya renombrados solo existe sys_set_updated_at.
do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'set_updated_at' and pg_get_function_arguments(p.oid) = ''
  ) and not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'sys_set_updated_at' and pg_get_function_arguments(p.oid) = ''
  ) then
    execute 'alter function public.set_updated_at() rename to sys_set_updated_at';
  end if;
end $$;

-- 4. Triggers: nombres alineados al prefijo --------------------------------
drop trigger if exists agency_orders_updated_at on io_agency_orders;
drop trigger if exists io_agency_orders_updated_at on io_agency_orders; -- idempotente: ya migrado
create trigger io_agency_orders_updated_at before update on io_agency_orders for each row execute function sys_set_updated_at();
drop trigger if exists campaigns_updated_at on io_campaigns;
drop trigger if exists io_campaigns_updated_at on io_campaigns; -- idempotente: ya migrado
create trigger io_campaigns_updated_at before update on io_campaigns for each row execute function sys_set_updated_at();
drop trigger if exists companies_updated_at on crm_companies;
drop trigger if exists crm_companies_updated_at on crm_companies; -- idempotente: ya migrado
create trigger crm_companies_updated_at before update on crm_companies for each row execute function sys_set_updated_at();
drop trigger if exists contacts_updated_at on crm_contacts;
drop trigger if exists crm_contacts_updated_at on crm_contacts; -- idempotente: ya migrado
create trigger crm_contacts_updated_at before update on crm_contacts for each row execute function sys_set_updated_at();
drop trigger if exists creatives_updated_at on io_creatives;
drop trigger if exists io_creatives_updated_at on io_creatives; -- idempotente: ya migrado
create trigger io_creatives_updated_at before update on io_creatives for each row execute function sys_set_updated_at();
drop trigger if exists insertion_orders_updated_at on io_orders;
drop trigger if exists io_orders_updated_at on io_orders; -- idempotente: ya migrado
create trigger io_orders_updated_at before update on io_orders for each row execute function sys_set_updated_at();
drop trigger if exists invoices_updated_at on io_invoices;
drop trigger if exists io_invoices_updated_at on io_invoices; -- idempotente: ya migrado
create trigger io_invoices_updated_at before update on io_invoices for each row execute function sys_set_updated_at();
drop trigger if exists screens_updated_at on inv_screens;
drop trigger if exists inv_screens_updated_at on inv_screens; -- idempotente: ya migrado
create trigger inv_screens_updated_at before update on inv_screens for each row execute function sys_set_updated_at();
drop trigger if exists store_profiles_updated_at on sys_store_profiles;
drop trigger if exists sys_store_profiles_updated_at on sys_store_profiles; -- idempotente: ya migrado
create trigger sys_store_profiles_updated_at before update on sys_store_profiles for each row execute function sys_set_updated_at();
drop trigger if exists venues_updated_at on inv_venues;
drop trigger if exists inv_venues_updated_at on inv_venues; -- idempotente: ya migrado
create trigger inv_venues_updated_at before update on inv_venues for each row execute function sys_set_updated_at();
drop trigger if exists vertical_profiles_updated_at on ai_vertical_profiles;
drop trigger if exists ai_vertical_profiles_updated_at on ai_vertical_profiles; -- idempotente: ya migrado
create trigger ai_vertical_profiles_updated_at before update on ai_vertical_profiles for each row execute function sys_set_updated_at();
drop trigger if exists bookings_hard_hold_overlap on inv_bookings;
drop trigger if exists inv_bookings_hard_hold_overlap on inv_bookings; -- idempotente: ya migrado
create trigger inv_bookings_hard_hold_overlap
  before insert or update on inv_bookings
  for each row execute function io_check_hold_overlap();
