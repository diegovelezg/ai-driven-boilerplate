-- Research de empresas (tab Perfil): revive el caché firmográfico por dominio.
-- La migración 20261122 eliminó `domains` con el motor de retención; el drawer
-- de empresas lo necesita de nuevo (company.domain + dominios de emails de
-- contactos → homepage → LLM → ficha). Global sin store_id: el mismo dominio
-- comparte ficha entre tiendas. Idempotente.
create table if not exists domains (
  domain       text primary key,
  domain_type  text not null default 'business'
    check (domain_type in ('business', 'institutional')),
  company_name text,
  industry     text,
  description  text,
  size         text,
  location     text,
  logo_url     text,
  source_url   text,
  model        text,
  confidence   numeric,
  enriched_at  timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

alter table domains enable row level security;
create index if not exists domains_enriched_at_idx on domains (enriched_at desc);
