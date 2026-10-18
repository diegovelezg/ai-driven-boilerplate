-- Metering LLM por tenant (issue #15).
-- Tabla append-only: una fila por llamada LLM con store_id obligatorio.
-- Escritura solo service_role (server-only via web/lib/ai/usage.ts).
-- Lectura directa por PostgREST protegida por RLS tenant (is_store_member).
-- Vista diaria agregada para GET /api/usage y panel por tienda.

create table llm_usage (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  process text not null,
  provider text not null,
  model text not null,
  prompt_tokens int not null default 0,
  completion_tokens int not null default 0,
  total_tokens int not null default 0,
  reasoning_tokens int null,
  latency_ms int null,
  used_fallback boolean not null default false,
  success boolean not null default true,
  created_at timestamptz not null default now()
);

alter table llm_usage enable row level security;

-- Lectura tenant-scoped (mismo patron que 20261016000017_merchant_auth.sql).
-- Sin policy de escritura para authenticated: solo service_role inserta.
create policy tenant_isolation on llm_usage
  for select to authenticated using (public.is_store_member(store_id));

create index llm_usage_store_created_idx on llm_usage (store_id, created_at desc);
create index llm_usage_process_idx on llm_usage (process);

create or replace view llm_usage_daily as
select
  store_id,
  date_trunc('day', created_at)::date as day,
  process,
  provider,
  model,
  count(*) as calls,
  sum(prompt_tokens) as prompt_tokens,
  sum(completion_tokens) as completion_tokens,
  sum(total_tokens) as total_tokens
from llm_usage
group by 1, 2, 3, 4, 5;
