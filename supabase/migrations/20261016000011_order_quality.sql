-- Calidad de órdenes: estado crudo + flag de prueba + desglose por moneda.
-- El sync guarda TODAS las órdenes (auditable) pero solo las reales
-- (no test, no canceladas/archivadas) alimentan los agregados del customer.
-- stats_by_currency evita mezclar monedas en orders_count/total_spent
-- (esos quedan en la moneda primaria; el desglose completo va aquí).
alter table orders
  add column status text,
  add column payment_status text,
  add column is_test boolean not null default false;

alter table customers
  add column stats_by_currency jsonb not null default '[]';

-- Backfill: marca órdenes de prueba ya sincronizadas (lista ES/EN,
-- palabra completa, case-insensitive; espejo de TEST_ITEM_KEYWORDS).
update orders set is_test = true
where not is_test
  and exists (
    select 1
    from jsonb_array_elements(items_json) i
    where (i ->> 'title') ~* '\y(prueba(s)?|probando|test(s|ing)?|teste|draft(s)?|borrador(es)?|dumm(y|ies)|fake(s)?|ejemplo(s)?|example(s)?|demo(s)?)\y'
  );
