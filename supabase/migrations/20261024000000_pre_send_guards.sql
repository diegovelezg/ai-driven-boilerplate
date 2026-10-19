-- Issue #13: bloqueantes pre-envío.
-- 1. Estado `skipped`: la revalidación no envía pero deja auditoría
--    (motivo en evidence_json.skip). No es `rejected` (decisión humana)
--    ni `failed` (error de proveedor): es "el sistema frenó el envío".
alter table proposed_actions drop constraint if exists proposed_actions_status_check;
alter table proposed_actions add constraint proposed_actions_status_check
  check (status in ('pending_review', 'approved', 'rejected', 'dispatched', 'failed', 'skipped'));

-- 2. Opt-outs mínimos por canal (baja del destinatario). Sin UI en v1:
--    se gestiona por server actions (optOut/optIn) y se respeta en
--    scout (sin señales si ambos canales), copywriter (sin borrador),
--    retention-suppressed vía gate y pre-envío (skip terminal).
create table opt_outs (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  customer_id uuid not null references customers (id) on delete cascade,
  channel text not null check (channel in ('whatsapp', 'email')),
  reason text,
  created_at timestamptz not null default now(),
  unique (store_id, customer_id, channel)
);
alter table opt_outs enable row level security;
-- Lectura tenant-scoped; escritura solo service_role (server-only).
create policy tenant_isolation on opt_outs
  for select to authenticated using (public.is_store_member(store_id));
create index opt_outs_store_customer_idx on opt_outs (store_id, customer_id, channel);
