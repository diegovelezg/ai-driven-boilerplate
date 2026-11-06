-- Numeración automática de órdenes: PREFIJO-AÑO-NNNN (ej. SM-2026-0005).
-- Las NP-2026-00x del seed quedan como legado; el correlativo 2026 arranca
-- después de lo ya existente para no reutilizar números con sentido.
alter table stores add column if not exists io_prefix text not null default 'OI'
  check (io_prefix ~ '^[A-Z]{2,4}$');

-- Backfill: iniciales de las dos primeras palabras (Strong Minds … → SM);
-- una sola palabra → dos primeras letras (Acme → AC).
update stores
set io_prefix = (
  select case
    when w1 <> '' and w2 <> '' then upper(left(w1, 1) || left(w2, 1))
    when char_length(w1) >= 2 then upper(left(w1, 2))
    else 'OI'
  end
  from (
    select
      regexp_replace(split_part(s.name, ' ', 1), '[^A-Za-z]', '', 'g') as w1,
      regexp_replace(nullif(split_part(s.name, ' ', 2), ''), '[^A-Za-z]', '', 'g') as w2
    from stores s where s.id = stores.id
  ) t
)
where io_prefix = 'OI';

create table if not exists order_counters (
  store_id uuid not null references stores (id) on delete cascade,
  year int not null check (year between 2000 and 2100),
  last_n int not null default 0 check (last_n >= 0),
  primary key (store_id, year)
);

-- El correlativo 2026 continúa donde quedó el seed (4 OIs → next 0005).
insert into order_counters (store_id, year, last_n)
select store_id, 2026, count(*)
from insertion_orders
group by store_id
on conflict (store_id, year) do update set last_n = excluded.last_n;

-- Minuta atómica: lock por fila de contador, año en hora Lima.
create or replace function mint_io_number(p_store uuid) returns text as $$
declare
  y int := extract(year from (now() at time zone 'America/Lima'))::int;
  n int;
  pfx text;
begin
  insert into order_counters (store_id, year, last_n)
  values (p_store, y, 1)
  on conflict (store_id, year)
  do update set last_n = order_counters.last_n + 1
  returning last_n into n;

  select io_prefix into pfx from stores where id = p_store;
  if pfx is null then pfx := 'OI'; end if;
  return pfx || '-' || y || '-' || lpad(n::text, 4, '0');
end;
$$ language plpgsql security definer
set search_path = public;

alter table order_counters enable row level security;
drop policy if exists tenant_isolation on order_counters;
create policy tenant_isolation on order_counters
  for all to authenticated
  using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
