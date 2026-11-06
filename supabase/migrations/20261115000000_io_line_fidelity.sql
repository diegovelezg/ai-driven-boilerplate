-- Fidelidad de líneas IO: fechas inclusivas de la OI + ítems del inventario.
-- La OI expresa FECHA INICIO / FECHA FIN inclusivas (pauta incluye el último día)
-- más CANT MES / CANT DÍAS / TARIFA REGULAR / TOTAL por fila.
-- El seed inicial guardó starts/ends en medianoche del mismo día (rango '[)'
-- recortaba el último día) y metió CANT/TARIFA solo en notes (Tottus la perdía).
-- Esta migración añade columnas estructuradas y repara las 4 OIs seed.

alter table insertion_order_lines
  add column if not exists cant_meses numeric check (cant_meses is null or cant_meses > 0),
  add column if not exists cant_dias numeric check (cant_dias is null or cant_dias > 0),
  add column if not exists tarifa_regular_minor int check (tarifa_regular_minor is null or tarifa_regular_minor >= 0);

comment on column insertion_order_lines.cant_meses is 'CANT MES tal cual figura en la OI (1 = un mes de pauta).';
comment on column insertion_order_lines.cant_dias is 'CANT. DÍAS tal cual figura en la OI.';
comment on column insertion_order_lines.tarifa_regular_minor is 'TARIFA REGULAR de la fila (minor). rate_minor = TOTAL de la fila.';

-- 1. ends_at exclusivo: la OI incluye el último día; el rango interno es '[)'.
--    Solo toca las 4 OIs seed (idempotente por fecha esperada vieja).
update insertion_order_lines l
set ends_at = l.ends_at + interval '1 day'
from insertion_orders o
where l.io_id = o.id
  and o.io_number in ('NP-2026-001', 'NP-2026-002', 'NP-2026-003', 'NP-2026-004')
  and l.ends_at in (
    timestamptz '2026-11-23 00:00:00-05',
    timestamptz '2026-09-30 00:00:00-05',
    timestamptz '2026-10-20 00:00:00-05',
    timestamptz '2026-11-22 00:00:00-05',
    timestamptz '2026-11-30 00:00:00-05'
  );

update bookings b
set ends_at = b.ends_at + interval '1 day'
from insertion_orders o
where b.insertion_order_id = o.id
  and o.io_number in ('NP-2026-001', 'NP-2026-002', 'NP-2026-003', 'NP-2026-004')
  and b.ends_at in (
    timestamptz '2026-11-23 00:00:00-05',
    timestamptz '2026-09-30 00:00:00-05',
    timestamptz '2026-10-20 00:00:00-05',
    timestamptz '2026-11-22 00:00:00-05',
    timestamptz '2026-11-30 00:00:00-05'
  );

-- 2. Backfill estructurado por (io_number, pantalla, inicio).
--    Tottus NP-2026-001: CANT DÍAS 4, tarifa 3000/4500, total 2000/3000.
update insertion_order_lines l
set cant_dias = 4,
    tarifa_regular_minor = case s.external_ref when 'MI010' then 300000 when 'MI001' then 450000 end,
    rate_minor = case s.external_ref when 'MI010' then 200000 when 'MI001' then 300000 end,
    notes = 'OI: CANT. DÍAS 4. Tarifa regular ' ||
      case s.external_ref when 'MI010' then 'S/ 3,000' when 'MI001' then 'S/ 4,500' end ||
      '; total línea ' ||
      case s.external_ref when 'MI010' then 'S/ 2,000.' when 'MI001' then 'S/ 3,000.' end
from insertion_orders o join screens s on s.id = l.screen_id
where l.io_id = o.id and o.io_number = 'NP-2026-001'
  and s.external_ref in ('MI010', 'MI001');

--    Toyota NP-2026-002 P1 (24/09-30/09 +1d): 7 días.
update insertion_order_lines l
set cant_dias = 7,
    tarifa_regular_minor = case s.external_ref
      when 'MI001' then 546000 when 'MI004' then 546000 else 385000 end,
    rate_minor = case s.external_ref
      when 'MI001' then 127400 when 'MI004' then 127400 else 89833 end
from insertion_orders o join screens s on s.id = l.screen_id
where l.io_id = o.id and o.io_number = 'NP-2026-002'
  and date(timezone('America/Lima', l.starts_at)) = date '2026-09-24';

--    Toyota NP-2026-002 P2 (01/10-20/10 +1d): 20 días.
update insertion_order_lines l
set cant_dias = 20,
    tarifa_regular_minor = case s.external_ref
      when 'MI001' then 546000 when 'MI004' then 546000 else 385000 end,
    rate_minor = case s.external_ref
      when 'MI001' then 364000 when 'MI004' then 364000 else 256667 end
from insertion_orders o join screens s on s.id = l.screen_id
where l.io_id = o.id and o.io_number = 'NP-2026-002'
  and date(timezone('America/Lima', l.starts_at)) = date '2026-10-01';

--    Pacífico NP-2026-003: 1 mes / 28 días.
update insertion_order_lines l
set cant_meses = 1,
    cant_dias = 28,
    tarifa_regular_minor = case s.external_ref when 'MI001' then 600000 else 480000 end,
    rate_minor = case s.external_ref when 'MI001' then 560000 else 448000 end
from insertion_orders o join screens s on s.id = l.screen_id
where l.io_id = o.id and o.io_number = 'NP-2026-003';

--    Qroma NP-2026-004: 1 mes, tarifa 5500, total 4400 por pantalla.
update insertion_order_lines l
set cant_meses = 1,
    tarifa_regular_minor = 550000,
    rate_minor = 440000
from insertion_orders o
where l.io_id = o.id and o.io_number = 'NP-2026-004';

-- 3. signed_at a medianoche Lima (el seed inicial mandó fecha sin zona y PG la
--    dejó en 00:00 UTC = día anterior 19:00 en Lima).
update insertion_orders
set signed_at = (signed_at::date)::text || 'T00:00:00-05:00'
where io_number in ('NP-2026-001', 'NP-2026-002', 'NP-2026-003', 'NP-2026-004')
  and date_part('hour', signed_at) = 0 and extract(timezone from signed_at) = 0;
