-- Simplificación CRM (nov-2026): la contraparte es UN tipo por empresa y la
-- marca es metadato del pedido, no una empresa.
-- - companies.kind: 'agencia' | 'anunciante' | 'proveedor'. NULL = la casa
--   (red propia, no es contraparte). Solo STRONG MINDS queda NULL.
-- - insertion_orders.brand: marca publicitada ("Toyota", "CPP"...). Una agencia
--   contrata PARA una marca; la marca también puede contratar directo: en ambos
--   casos la marca va en brand, y la contraparte (quien firma/paga) en
--   advertiser/billing_company_id.
-- - Cliente/prospecto NO se guardan: se derivan (¿tiene IO firmada?).
-- - company_roles se elimina: era la fuente de la duplicidad.
-- - Las marcas sin ID fiscal (Toyota, CPP) dejan de ser companies.

alter table companies
  add column if not exists kind text check (kind is null or kind in ('agencia', 'anunciante', 'proveedor'));

alter table insertion_orders
  add column if not exists brand text check (brand is null or char_length(btrim(brand)) > 0);

-- Backfill tipo por contraparte (IDs fiscales de las OIs seed).
update companies set kind = 'agencia'
where tax_id in ('20476465614', '20100335604', '20609099888', '20600995031') and kind is null;

update companies set kind = 'anunciante'
where tax_id in ('20508565934', '20332970411') and kind is null;

-- Backfill marca publicitada (metadato, tal cual figura en la OI).
update insertion_orders set brand = 'Tottus' where io_number = 'NP-2026-001' and brand is null;
update insertion_orders set brand = 'Toyota' where io_number = 'NP-2026-002' and brand is null;
update insertion_orders set brand = 'PACÍFICO' where io_number = 'NP-2026-003' and brand is null;
update insertion_orders set brand = 'CPP' where io_number = 'NP-2026-004' and brand is null;

-- Las marcas dejan de ser companies: advertiser vuelve a null y se borran.
update insertion_orders o set advertiser_company_id = null
from companies c
where o.advertiser_company_id = c.id and c.tax_id is null and c.name in ('Toyota', 'CPP');

update campaigns m set advertiser_company_id = null
from insertion_orders o, companies c
where m.insertion_order_id = o.id
  and o.advertiser_company_id is null
  and m.advertiser_company_id = c.id
  and c.tax_id is null and c.name in ('Toyota', 'CPP');

delete from companies where tax_id is null and name in ('Toyota', 'CPP');

-- Sin tabla de roles: policies mueren con la tabla.
drop table if exists company_roles;
