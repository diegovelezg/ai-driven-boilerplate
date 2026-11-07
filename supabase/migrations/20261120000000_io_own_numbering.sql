-- Numeración propia del tenant: las NP-2026-00x del seed eran la
-- numeración del cliente/agencia y se ignoran. El tenant usa su correlativo
-- (stores.io_prefix + año): SM-2026-0001..0004, preservando el sufijo para
-- trazabilidad. Idempotente: solo toca filas con prefijo NP-2026-.
-- Requiere: seed NP aplicado + 20261115 (fidelidad) + 20261116 (contador).

-- Prefijo propio: iniciales de Strong Minds (el backfill de 20261116 dejó
-- 'OI' porque el nombre del store está vacío).
update stores set io_prefix = 'SM'
where id in (select store_id from insertion_orders where io_number like 'NP-2026-%')
  and io_prefix is distinct from 'SM';

update insertion_orders
set io_number = replace(io_number, 'NP-2026-', 'SM-2026-')
where io_number like 'NP-2026-%';

-- Notas de campaña generadas por el seed ("Seed NP-2026-0001.").
update campaigns
set notes = replace(notes, 'Seed NP-2026-', 'Seed SM-2026-')
where notes like '%Seed NP-2026-%';

-- El correlativo 2026 queda en 4 (siguiente a mintear: SM-2026-0005).
insert into order_counters (store_id, year, last_n)
select store_id, 2026, count(*)
from insertion_orders
where io_number like 'SM-2026-%'
group by store_id
on conflict (store_id, year) do update set last_n = excluded.last_n;
