-- Muro de insights (issue #11): brecha KPI → lectura.
-- Un solo muro por tenant (SSOT): sys_insights + dismiss per-user en
-- sys_insight_reads. Sin bandejas por usuario; lo personal es el filtro
-- `Mis pendientes` (audience_json) en la UI, no tablas separadas.
--
-- Analizador determinista 1x día vía sys_runs kind='brief' (ver
-- web/lib/insights.ts:runBriefJob) + un solo narrador LLM
-- (process brief_narrate en web/config/llm_models.json, metering en
-- ai_llm_usage). Anti-ruido: máx 5/día y dedupe por (kind+scope) en código;
-- la DB solo indexa, no inventa políticas con triggers.

create table if not exists public.sys_insights (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.sys_stores (id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null,
  links_json jsonb not null default '[]'::jsonb,
  audience_json jsonb not null default '{}'::jsonb,
  severity text not null default 'info',
  scope_kind text null,
  scope_id uuid null,
  created_at timestamptz not null default now()
);

create table if not exists public.sys_insight_reads (
  insight_id uuid not null references public.sys_insights (id) on delete cascade,
  user_id uuid not null,
  read_at timestamptz not null default now(),
  primary key (insight_id, user_id)
);

alter table public.sys_insights enable row level security;
alter table public.sys_insight_reads enable row level security;

drop policy if exists tenant_isolation on public.sys_insights;
create policy tenant_isolation on public.sys_insights
  for all to authenticated using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

drop policy if exists tenant_isolation on public.sys_insight_reads;
create policy tenant_isolation on public.sys_insight_reads
  for all to authenticated
  using (
    exists (
      select 1 from public.sys_insights i
      where i.id = sys_insight_reads.insight_id
        and public.is_store_member(i.store_id)
    )
  )
  with check (
    exists (
      select 1 from public.sys_insights i
      where i.id = sys_insight_reads.insight_id
        and public.is_store_member(i.store_id)
    )
  );

create index if not exists sys_insights_store_created_idx
  on public.sys_insights (store_id, created_at desc);
create index if not exists sys_insights_store_kind_scope_idx
  on public.sys_insights (store_id, kind, scope_id);
create index if not exists sys_insight_reads_user_idx
  on public.sys_insight_reads (user_id);
