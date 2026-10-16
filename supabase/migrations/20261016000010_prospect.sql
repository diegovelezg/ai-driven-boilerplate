-- Lead stream (prospector, Fase B): ICP manual por tienda + leads propuestos.
-- El humano revisa y aprueba; el prospector nunca contacta solo.
alter table store_profiles
  add column icp_description text;   -- quién es el cliente ideal (lo escribe el merchant)

create table proposed_leads (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references stores (id) on delete cascade,
  source      text not null default 'searxng', -- 'searxng' | 'manual'
  company     text,                          -- nombre detectado
  domain      text,                          -- dominio detectado (dedupe)
  url         text not null,                 -- URL origen del hallazgo
  contact     text,                          -- email/teléfono si era público
  icp_score   float,                         -- 0..1 afinidad con el ICP
  reason      text,                          -- por qué encaja, legible
  status      text not null default 'pending_review'
    check (status in ('pending_review', 'approved', 'rejected', 'contacted', 'discarded')),
  created_at  timestamptz not null default now()
);

alter table proposed_leads enable row level security;
create index proposed_leads_store_status_idx
  on proposed_leads (store_id, status, created_at desc);
create unique index proposed_leads_store_url_idx
  on proposed_leads (store_id, url);
