-- Same-store enforcement: las FKs simples (child_id -> parent(id)) validan
-- existencia pero no tenant. Un bug con service_role podría colgar una línea
-- de un tenant a una pantalla/empresa de otro. Estas FKs compuestas
-- (store_id, fk) -> parent(store_id, id) lo hacen imposible a nivel DB.
-- Son check-only: ON UPDATE CASCADE ON DELETE NO ACTION. El comportamiento
-- de borrado lo sigue gobernando la FK original (CASCADE/SET NULL/RESTRICT).
-- Solo ADD (sin DROP): no aplica la política de DROP seguro.

-- 0. Pre-chequeo fail-closed: aborta si ya hay filas cruzadas entre tenants.
do $$
declare
  n int;
begin
  select count(*) into n from crm_contacts cc join crm_companies c on c.id = cc.company_id where cc.company_id is not null and cc.store_id <> c.store_id;
  if n > 0 then raise exception 'same-store bloqueado: crm_contacts.company_id cruza tenant en % filas', n; end if;

  select count(*) into n from inv_venues v join crm_companies c on c.id = v.company_id where v.company_id is not null and v.store_id <> c.store_id;
  if n > 0 then raise exception 'same-store bloqueado: inv_venues.company_id cruza tenant en % filas', n; end if;
  select count(*) into n from inv_venues v join crm_companies c on c.id = v.supplier_company_id where v.supplier_company_id is not null and v.store_id <> c.store_id;
  if n > 0 then raise exception 'same-store bloqueado: inv_venues.supplier_company_id cruza tenant en % filas', n; end if;

  select count(*) into n from inv_screens s join inv_venues v on v.id = s.venue_id where s.store_id <> v.store_id;
  if n > 0 then raise exception 'same-store bloqueado: inv_screens.venue_id cruza tenant en % filas', n; end if;
  select count(*) into n from inv_screens s join crm_companies c on c.id = s.supplier_company_id where s.supplier_company_id is not null and s.store_id <> c.store_id;
  if n > 0 then raise exception 'same-store bloqueado: inv_screens.supplier_company_id cruza tenant en % filas', n; end if;

  select count(*) into n from inv_slots sl join inv_screens s on s.id = sl.screen_id where sl.store_id <> s.store_id;
  if n > 0 then raise exception 'same-store bloqueado: inv_slots.screen_id cruza tenant en % filas', n; end if;
  select count(*) into n from inv_slots sl join inv_loop_templates t on t.id = sl.loop_template_id where sl.loop_template_id is not null and sl.store_id <> t.store_id;
  if n > 0 then raise exception 'same-store bloqueado: inv_slots.loop_template_id cruza tenant en % filas', n; end if;

  select count(*) into n from inv_screen_embeddings e join inv_screens s on s.id = e.screen_id where e.store_id <> s.store_id;
  if n > 0 then raise exception 'same-store bloqueado: inv_screen_embeddings.screen_id cruza tenant en % filas', n; end if;

  select count(*) into n from io_campaigns k join crm_companies c on c.id = k.advertiser_company_id where k.advertiser_company_id is not null and k.store_id <> c.store_id;
  if n > 0 then raise exception 'same-store bloqueado: io_campaigns.advertiser cruza tenant en % filas', n; end if;
  select count(*) into n from io_campaigns k join io_orders o on o.id = k.insertion_order_id where k.insertion_order_id is not null and k.store_id <> o.store_id;
  if n > 0 then raise exception 'same-store bloqueado: io_campaigns.insertion_order_id cruza tenant en % filas', n; end if;

  select count(*) into n from inv_bookings b join inv_slots sl on sl.id = b.slot_id where b.store_id <> sl.store_id;
  if n > 0 then raise exception 'same-store bloqueado: inv_bookings.slot_id cruza tenant en % filas', n; end if;
  select count(*) into n from inv_bookings b join io_campaigns k on k.id = b.campaign_id where b.campaign_id is not null and b.store_id <> k.store_id;
  if n > 0 then raise exception 'same-store bloqueado: inv_bookings.campaign_id cruza tenant en % filas', n; end if;
  select count(*) into n from inv_bookings b join io_orders o on o.id = b.insertion_order_id where b.insertion_order_id is not null and b.store_id <> o.store_id;
  if n > 0 then raise exception 'same-store bloqueado: inv_bookings.insertion_order_id cruza tenant en % filas', n; end if;

  select count(*) into n from io_orders o join crm_companies c on c.id = o.advertiser_company_id where o.advertiser_company_id is not null and o.store_id <> c.store_id;
  if n > 0 then raise exception 'same-store bloqueado: io_orders.advertiser cruza tenant en % filas', n; end if;
  select count(*) into n from io_orders o join crm_companies c on c.id = o.billing_company_id where o.billing_company_id is not null and o.store_id <> c.store_id;
  if n > 0 then raise exception 'same-store bloqueado: io_orders.billing cruza tenant en % filas', n; end if;

  select count(*) into n from io_lines l join io_orders o on o.id = l.io_id where l.store_id <> o.store_id;
  if n > 0 then raise exception 'same-store bloqueado: io_lines.io_id cruza tenant en % filas', n; end if;
  select count(*) into n from io_lines l join inv_screens s on s.id = l.screen_id where l.store_id <> s.store_id;
  if n > 0 then raise exception 'same-store bloqueado: io_lines.screen_id cruza tenant en % filas', n; end if;
  select count(*) into n from io_lines l join inv_slots sl on sl.id = l.slot_id where l.slot_id is not null and l.store_id <> sl.store_id;
  if n > 0 then raise exception 'same-store bloqueado: io_lines.slot_id cruza tenant en % filas', n; end if;

  select count(*) into n from io_agency_orders a join io_orders o on o.id = a.io_id where a.store_id <> o.store_id;
  if n > 0 then raise exception 'same-store bloqueado: io_agency_orders.io_id cruza tenant en % filas', n; end if;
  select count(*) into n from io_creatives c join io_orders o on o.id = c.io_id where c.store_id <> o.store_id;
  if n > 0 then raise exception 'same-store bloqueado: io_creatives.io_id cruza tenant en % filas', n; end if;

  select count(*) into n from io_photo_checks p join io_orders o on o.id = p.io_id where p.store_id <> o.store_id;
  if n > 0 then raise exception 'same-store bloqueado: io_photo_checks.io_id cruza tenant en % filas', n; end if;
  select count(*) into n from io_photo_checks p join inv_screens s on s.id = p.screen_id where p.screen_id is not null and p.store_id <> s.store_id;
  if n > 0 then raise exception 'same-store bloqueado: io_photo_checks.screen_id cruza tenant en % filas', n; end if;

  select count(*) into n from io_play_logs p join io_orders o on o.id = p.io_id where p.io_id is not null and p.store_id <> o.store_id;
  if n > 0 then raise exception 'same-store bloqueado: io_play_logs.io_id cruza tenant en % filas', n; end if;
  select count(*) into n from io_play_logs p join inv_screens s on s.id = p.screen_id where p.screen_id is not null and p.store_id <> s.store_id;
  if n > 0 then raise exception 'same-store bloqueado: io_play_logs.screen_id cruza tenant en % filas', n; end if;
  select count(*) into n from io_play_logs p join inv_slots sl on sl.id = p.slot_id where p.slot_id is not null and p.store_id <> sl.store_id;
  if n > 0 then raise exception 'same-store bloqueado: io_play_logs.slot_id cruza tenant en % filas', n; end if;

  select count(*) into n from io_invoices i join io_orders o on o.id = i.io_id where i.io_id is not null and i.store_id <> o.store_id;
  if n > 0 then raise exception 'same-store bloqueado: io_invoices.io_id cruza tenant en % filas', n; end if;

  select count(*) into n from sys_stores s join crm_companies c on c.id = s.home_company_id where s.home_company_id is not null and s.id <> c.store_id;
  if n > 0 then raise exception 'same-store bloqueado: sys_stores.home_company_id cruza tenant en % filas', n; end if;
end $$;

-- 1. UNIQUE(store_id, id) en padres (requisito para FK compuesta). Idempotente.
do $$ begin if not exists (select 1 from pg_constraint where conname = 'crm_companies_store_uq') then alter table crm_companies add constraint crm_companies_store_uq unique (store_id, id); end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conname = 'crm_contacts_store_uq') then alter table crm_contacts add constraint crm_contacts_store_uq unique (store_id, id); end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conname = 'inv_venues_store_uq') then alter table inv_venues add constraint inv_venues_store_uq unique (store_id, id); end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conname = 'inv_screens_store_uq') then alter table inv_screens add constraint inv_screens_store_uq unique (store_id, id); end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conname = 'inv_loop_templates_store_uq') then alter table inv_loop_templates add constraint inv_loop_templates_store_uq unique (store_id, id); end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conname = 'inv_slots_store_uq') then alter table inv_slots add constraint inv_slots_store_uq unique (store_id, id); end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conname = 'io_orders_store_uq') then alter table io_orders add constraint io_orders_store_uq unique (store_id, id); end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conname = 'io_campaigns_store_uq') then alter table io_campaigns add constraint io_campaigns_store_uq unique (store_id, id); end if; end $$;

-- 2. FKs compuestas check-only. Idempotentes.
do $$ begin if not exists (select 1 from pg_constraint where conname = 'crm_contacts_company_same_store_fk') then alter table crm_contacts add constraint crm_contacts_company_same_store_fk foreign key (store_id, company_id) references crm_companies (store_id, id) on update cascade on delete no action; end if; end $$;

do $$ begin if not exists (select 1 from pg_constraint where conname = 'inv_venues_company_same_store_fk') then alter table inv_venues add constraint inv_venues_company_same_store_fk foreign key (store_id, company_id) references crm_companies (store_id, id) on update cascade on delete no action; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conname = 'inv_venues_supplier_same_store_fk') then alter table inv_venues add constraint inv_venues_supplier_same_store_fk foreign key (store_id, supplier_company_id) references crm_companies (store_id, id) on update cascade on delete no action; end if; end $$;

do $$ begin if not exists (select 1 from pg_constraint where conname = 'inv_screens_venue_same_store_fk') then alter table inv_screens add constraint inv_screens_venue_same_store_fk foreign key (store_id, venue_id) references inv_venues (store_id, id) on update cascade on delete no action; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conname = 'inv_screens_supplier_same_store_fk') then alter table inv_screens add constraint inv_screens_supplier_same_store_fk foreign key (store_id, supplier_company_id) references crm_companies (store_id, id) on update cascade on delete no action; end if; end $$;

do $$ begin if not exists (select 1 from pg_constraint where conname = 'inv_slots_screen_same_store_fk') then alter table inv_slots add constraint inv_slots_screen_same_store_fk foreign key (store_id, screen_id) references inv_screens (store_id, id) on update cascade on delete no action; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conname = 'inv_slots_loop_same_store_fk') then alter table inv_slots add constraint inv_slots_loop_same_store_fk foreign key (store_id, loop_template_id) references inv_loop_templates (store_id, id) on update cascade on delete no action; end if; end $$;

do $$ begin if not exists (select 1 from pg_constraint where conname = 'inv_screen_embeddings_screen_same_store_fk') then alter table inv_screen_embeddings add constraint inv_screen_embeddings_screen_same_store_fk foreign key (store_id, screen_id) references inv_screens (store_id, id) on update cascade on delete no action; end if; end $$;

do $$ begin if not exists (select 1 from pg_constraint where conname = 'io_campaigns_advertiser_same_store_fk') then alter table io_campaigns add constraint io_campaigns_advertiser_same_store_fk foreign key (store_id, advertiser_company_id) references crm_companies (store_id, id) on update cascade on delete no action; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conname = 'io_campaigns_io_same_store_fk') then alter table io_campaigns add constraint io_campaigns_io_same_store_fk foreign key (store_id, insertion_order_id) references io_orders (store_id, id) on update cascade on delete no action; end if; end $$;
-- primary_contact_id existe desde 20261112000001 (crm_polish): solo si la columna está.
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'io_campaigns' and column_name = 'primary_contact_id')
     and not exists (select 1 from pg_constraint where conname = 'io_campaigns_contact_same_store_fk') then
    alter table io_campaigns add constraint io_campaigns_contact_same_store_fk foreign key (store_id, primary_contact_id) references crm_contacts (store_id, id) on update cascade on delete no action;
  end if;
end $$;

do $$ begin if not exists (select 1 from pg_constraint where conname = 'inv_bookings_slot_same_store_fk') then alter table inv_bookings add constraint inv_bookings_slot_same_store_fk foreign key (store_id, slot_id) references inv_slots (store_id, id) on update cascade on delete no action; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conname = 'inv_bookings_campaign_same_store_fk') then alter table inv_bookings add constraint inv_bookings_campaign_same_store_fk foreign key (store_id, campaign_id) references io_campaigns (store_id, id) on update cascade on delete no action; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conname = 'inv_bookings_io_same_store_fk') then alter table inv_bookings add constraint inv_bookings_io_same_store_fk foreign key (store_id, insertion_order_id) references io_orders (store_id, id) on update cascade on delete no action; end if; end $$;

do $$ begin if not exists (select 1 from pg_constraint where conname = 'io_orders_advertiser_same_store_fk') then alter table io_orders add constraint io_orders_advertiser_same_store_fk foreign key (store_id, advertiser_company_id) references crm_companies (store_id, id) on update cascade on delete no action; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conname = 'io_orders_billing_same_store_fk') then alter table io_orders add constraint io_orders_billing_same_store_fk foreign key (store_id, billing_company_id) references crm_companies (store_id, id) on update cascade on delete no action; end if; end $$;

do $$ begin if not exists (select 1 from pg_constraint where conname = 'io_lines_io_same_store_fk') then alter table io_lines add constraint io_lines_io_same_store_fk foreign key (store_id, io_id) references io_orders (store_id, id) on update cascade on delete no action; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conname = 'io_lines_screen_same_store_fk') then alter table io_lines add constraint io_lines_screen_same_store_fk foreign key (store_id, screen_id) references inv_screens (store_id, id) on update cascade on delete no action; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conname = 'io_lines_slot_same_store_fk') then alter table io_lines add constraint io_lines_slot_same_store_fk foreign key (store_id, slot_id) references inv_slots (store_id, id) on update cascade on delete no action; end if; end $$;

do $$ begin if not exists (select 1 from pg_constraint where conname = 'io_agency_orders_io_same_store_fk') then alter table io_agency_orders add constraint io_agency_orders_io_same_store_fk foreign key (store_id, io_id) references io_orders (store_id, id) on update cascade on delete no action; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conname = 'io_creatives_io_same_store_fk') then alter table io_creatives add constraint io_creatives_io_same_store_fk foreign key (store_id, io_id) references io_orders (store_id, id) on update cascade on delete no action; end if; end $$;

do $$ begin if not exists (select 1 from pg_constraint where conname = 'io_photo_checks_io_same_store_fk') then alter table io_photo_checks add constraint io_photo_checks_io_same_store_fk foreign key (store_id, io_id) references io_orders (store_id, id) on update cascade on delete no action; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conname = 'io_photo_checks_screen_same_store_fk') then alter table io_photo_checks add constraint io_photo_checks_screen_same_store_fk foreign key (store_id, screen_id) references inv_screens (store_id, id) on update cascade on delete no action; end if; end $$;

do $$ begin if not exists (select 1 from pg_constraint where conname = 'io_play_logs_io_same_store_fk') then alter table io_play_logs add constraint io_play_logs_io_same_store_fk foreign key (store_id, io_id) references io_orders (store_id, id) on update cascade on delete no action; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conname = 'io_play_logs_screen_same_store_fk') then alter table io_play_logs add constraint io_play_logs_screen_same_store_fk foreign key (store_id, screen_id) references inv_screens (store_id, id) on update cascade on delete no action; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conname = 'io_play_logs_slot_same_store_fk') then alter table io_play_logs add constraint io_play_logs_slot_same_store_fk foreign key (store_id, slot_id) references inv_slots (store_id, id) on update cascade on delete no action; end if; end $$;

do $$ begin if not exists (select 1 from pg_constraint where conname = 'io_invoices_io_same_store_fk') then alter table io_invoices add constraint io_invoices_io_same_store_fk foreign key (store_id, io_id) references io_orders (store_id, id) on update cascade on delete no action; end if; end $$;

-- 3. sys_stores.home_company_id es dirección inversa (store -> company):
-- no admite FK compuesta, se blinda con trigger.
create or replace function public.check_sys_store_home_company() returns trigger
language plpgsql as $$
begin
  if new.home_company_id is not null then
    if not exists (
      select 1 from crm_companies c where c.id = new.home_company_id and c.store_id = new.id
    ) then
      raise exception 'same-store bloqueado: sys_stores.home_company_id % no pertenece al store %', new.home_company_id, new.id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists sys_stores_home_company_same_store on sys_stores;
create trigger sys_stores_home_company_same_store
  before insert or update of home_company_id on sys_stores
  for each row execute function public.check_sys_store_home_company();
