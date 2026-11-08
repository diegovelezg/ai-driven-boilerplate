-- SSOT de moneda (issue #6 P1): un solo dominio ISO + paridad IO↔facturas +
-- entierro de la columna muerta inv_screens.currency.
--
-- 1) Dominio compartido: ISO3 mayúsculas, sin códigos no monetarios
--    (XXX/ZZZ/XTS son placeholders de test, XAU/XAG/XDR no son moneda).
-- 2) io_orders.currency / io_invoices.currency / sys_stores.shop_currency
--    pasan al dominio (normalización previa; denylist → RAISE, nunca remap
--    silencioso).
-- 3) Paridad: la factura nace con la moneda explícita de su IO. Trigger que
--    aborta el mismatch PEN↔USD en escritura (nunca conversión silenciosa).
-- 4) inv_screens.currency nunca se leyó ni escribió en web/ (cero usos en
--    screens-db/screens-actions/RPCs): DROP con guarda RAISE si algún entorno
--    trae un valor distinto de 'PEN' (el default que la app jamás tocó).

-- 1) Dominio -----------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'currency_iso') then
    create domain public.currency_iso as text
      check (value ~ '^[A-Z]{3}$' and value not in ('XXX', 'ZZZ', 'XTS', 'XAU', 'XAG', 'XDR'));
  end if;
end $$;

-- 2) Normalización previa (upper/trim; denylist → excepción explícita) --------
do $$
declare
  bad text;
begin
  select string_agg(distinct v, ', ') into bad
  from (
    select upper(btrim(currency)) as v from public.io_orders
    union
    select upper(btrim(currency)) as v from public.io_invoices
    union
    select upper(btrim(shop_currency)) as v from public.sys_stores
  ) s
  where v in ('XXX', 'ZZZ', 'XTS', 'XAU', 'XAG', 'XDR');
  if bad is not null then
    raise exception 'currency_ssot: códigos no monetarios en datos: % (fijar a ISO real antes de migrar)', bad;
  end if;
end $$;

update public.io_orders
set currency = upper(btrim(currency))
where currency is distinct from upper(btrim(currency));
update public.io_orders set currency = 'PEN'
where currency is null or btrim(currency) = '';

update public.io_invoices
set currency = upper(btrim(currency))
where currency is distinct from upper(btrim(currency));
update public.io_invoices set currency = 'PEN'
where currency is null or btrim(currency) = '';

update public.sys_stores
set shop_currency = upper(btrim(shop_currency))
where shop_currency is distinct from upper(btrim(shop_currency));
update public.sys_stores set shop_currency = 'PEN'
where shop_currency is null or btrim(shop_currency) = '';

-- 3) Dominio en columnas (el CHECK suelto io_orders_currency_iso queda
--    reemplazado por el dominio, más estricto) --------------------------------
alter table public.io_orders drop constraint if exists io_orders_currency_iso;
alter table public.io_orders
  alter column currency type public.currency_iso using currency::public.currency_iso;

alter table public.io_invoices
  alter column currency type public.currency_iso using currency::public.currency_iso;

alter table public.sys_stores
  alter column shop_currency type public.currency_iso using shop_currency::public.currency_iso;

-- 4) Paridad IO↔factura en escritura ------------------------------------------
--    La factura hereda la moneda de su IO de forma explícita al escribirla
--    (o la trae ya puesta e igual). Mismatch → RAISE, nunca suma mixta.
--    Solo dispara si cambia el vínculo o la moneda (filas legacy intactas
--    hasta que alguien toque su dinero).
create or replace function public.io_invoice_currency_check()
returns trigger
language plpgsql
as $$
declare
  order_cur public.currency_iso;
begin
  if new.io_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE'
    and new.io_id is not distinct from old.io_id
    and new.currency is not distinct from old.currency then
    return new;
  end if;
  select o.currency into order_cur
  from public.io_orders o
  where o.id = new.io_id;
  if not found then
    raise exception 'io_invoice_currency_check: factura % referencia IO inexistente %', new.id, new.io_id;
  end if;
  if new.currency is distinct from order_cur then
    raise exception 'io_invoice_currency_check: factura % en % contra IO % en % (fija la moneda explícita, sin mezcla)',
      new.id, new.currency, new.io_id, order_cur;
  end if;
  return new;
end $$;

drop trigger if exists io_invoices_currency_parity on public.io_invoices;
create trigger io_invoices_currency_parity
  before insert or update on public.io_invoices
  for each row execute function public.io_invoice_currency_check();

-- Reporte honesto de legacy (NOTICE, no excepción: lo viejo se exhibe,
-- lo nuevo se bloquea).
do $$
declare
  n int;
begin
  select count(*) into n
  from public.io_invoices v
  join public.io_orders o on o.id = v.io_id
  where v.currency is distinct from o.currency;
  if n > 0 then
    raise notice 'currency_ssot: % factura(s) legacy con moneda distinta a su IO (pre-trigger; corregir en origen)', n;
  end if;
end $$;

-- 5) Entierro de inv_screens.currency (columna muerta) -------------------------
--    Política DROP seguro (AGENTS.md): guarda RAISE antes del DROP.
do $$
declare
  n int;
  ejemplo text;
begin
  select count(*), max(currency) into n, ejemplo
  from public.inv_screens
  where currency is distinct from 'PEN';
  if n > 0 then
    raise exception 'currency_ssot: inv_screens.currency tiene % valor(es) no-PEN (ej. %); decidir lectura/escritura antes de dropear', n, ejemplo;
  end if;
end $$;

alter table public.inv_screens drop column if exists currency;
