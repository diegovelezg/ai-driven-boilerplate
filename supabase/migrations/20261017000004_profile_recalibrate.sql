-- Vigilante semanal de perfil tenant (feature #6).
-- Scan determinista semanal: snapshot de stats + perfil, y propuestas de
-- corrección SOLO de los slots con drift, con aprobación humana por delta.
-- Nunca auto-apply: sin decisión del merchant, el perfil no cambia.

-- Slots fijados a mano por el merchant (archetype, repurchase_cycle_days,
-- taxonomy_id, buyer_type). El vigilante nunca propone cambiarlos.
alter table store_profiles
  add column if not exists manual_slots text[] not null default '{}';

-- Backfill: en perfiles legados con archetype_source='manual', cada slot
-- relleno fue fijado a mano (el form antiguo solo guardaba a mano) y queda
-- protegido. Los NULL (auto por arquetipo) siguen proponibles.
update store_profiles
  set manual_slots = array['archetype']
    || case when repurchase_cycle_days is not null then array['repurchase_cycle_days'] else '{}' end
    || case when taxonomy_id is not null then array['taxonomy_id'] else '{}' end
    || case when buyer_type is not null then array['buyer_type'] else '{}' end
  where archetype_source = 'manual'
    and coalesce(manual_slots, '{}') = '{}';

-- Lo que el scan midió (tenantStats) + copia del perfil vigente. 1 fila/mes.
create table if not exists profile_snapshots (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  taken_at timestamptz not null default now(),
  stats_json jsonb not null,
  profile_json jsonb not null
);
create index if not exists profile_snapshots_store_taken_idx
  on profile_snapshots (store_id, taken_at desc);

-- Propuesta de corrección: deltas por slot con [Aceptar]/[Rechazar] (HITL).
-- deltas = [{slot, de, a, evidencia, confianza, decision, decided_at}]
-- decision: pending | accepted | rejected.
create table if not exists profile_proposals (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  status text not null default 'pending_review'
    check (status in ('pending_review', 'approved', 'rejected', 'expired')),
  -- triggers del scan que dispararon (buyers_ratio, interval_drift, manual...)
  trigger text not null,
  provisional boolean not null default false,
  deltas jsonb not null default '[]',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  decided_at timestamptz
);
create index if not exists profile_proposals_store_created_idx
  on profile_proposals (store_id, created_at desc);

-- Tope duro: máximo 1 propuesta pendiente por tenant.
create unique index if not exists profile_proposals_one_pending_idx
  on profile_proposals (store_id) where status = 'pending_review';

-- Versión optimista para la decisión por delta (HITL concurrente):
-- el update reclama con where version=visto; 0 filas = otro decidió antes.
alter table profile_proposals
  add column if not exists version int not null default 1;

alter table profile_snapshots enable row level security;
alter table profile_proposals enable row level security;

drop policy if exists tenant_isolation on profile_snapshots;
drop policy if exists tenant_isolation on profile_proposals;
create policy tenant_isolation on profile_snapshots
  for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy tenant_isolation on profile_proposals
  for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
