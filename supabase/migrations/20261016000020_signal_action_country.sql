-- País desnormalizado en señales y acciones para el filtro global (?market=).
-- Sin esto, filtrar exige `.in(customer_id, <miles de ids>)` y PostgREST
-- responde "URI too long". Con ISO2 (2 chars) el filtro siempre es corto,
-- incluso en markets multi-país (Shopify): `country IN ('PE','CL')`.
-- Los writers (scout/copywriter) escriben country al crear; esto rellena
-- lo histórico desde customers.country (ver 0019_market_country).

alter table churn_signals add column if not exists country text;
alter table proposed_actions add column if not exists country text;

update churn_signals s
set country = c.country
from customers c
where s.customer_id = c.id
  and s.country is null
  and c.country is not null;

update proposed_actions a
set country = c.country
from customers c
where a.customer_id = c.id
  and a.country is null
  and c.country is not null;

create index if not exists churn_signals_store_country_idx on churn_signals (store_id, country);
create index if not exists proposed_actions_store_country_idx on proposed_actions (store_id, country);
