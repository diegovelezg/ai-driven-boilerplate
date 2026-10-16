-- Enriquecimiento por dominio (firmográficos desde la web de la empresa).
-- Clave = dominio (global): se comparte entre customers y, a futuro, entre stores.
-- Solo entran dominios de negocio/institucionales (webmail nunca se enriquece).
-- El "hash" aquí es el propio dominio: si ya existe fila, no se re-scrapea
-- (a diferencia del input_hash de customers, que cambia con cada orden/edición).

create table domains (
  domain       text primary key,          -- lowercase, sin www
  domain_type  text not null default 'business'
    check (domain_type in ('business', 'institutional')),
  company_name text,
  industry     text,
  description  text,
  size         text,                       -- estimado: micro | pequeña | mediana | grande
  location     text,
  logo_url     text,
  source_url   text,                       -- URL de donde se extrajo
  model        text,                       -- provider/model usado
  confidence   numeric,                    -- 0..1
  enriched_at  timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

alter table domains enable row level security;
create index domains_enriched_at_idx on domains (enriched_at desc);
