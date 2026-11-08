-- Moneda por IO: un país (PE) puede facturar en PEN y USD.
-- El tenant conserva shop_currency como default/moneda base, pero el dinero
-- real vive en io_orders.currency (las líneas heredan la moneda de su IO).
-- Regla: nunca sumar mixto; agrupar por moneda en la app.

-- 1) Columna moneda de la IO.
alter table io_orders add column if not exists currency text;

-- 2) Backfill: moneda del tenant; fallback PEN.
update io_orders o
set currency = s.shop_currency
from sys_stores s
where o.store_id = s.id
  and (o.currency is null or btrim(o.currency) = '');

update io_orders
set currency = 'PEN'
where currency is null or btrim(currency) = '';

update io_orders
set currency = upper(btrim(currency))
where currency <> upper(btrim(currency));

-- 3) Default + not null + check ISO3.
alter table io_orders alter column currency set default 'PEN';
alter table io_orders alter column currency set not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'io_orders_currency_iso') then
    alter table io_orders add constraint io_orders_currency_iso check (currency ~ '^[A-Z]{3}$');
  end if;
end $$;

create index if not exists io_orders_store_currency_idx on io_orders (store_id, currency);
