-- Manejador centralizado de estados (issue #16, Fase 0): la cinta pasa de
-- 1 slot (última corrida) a N chips (runs activos + terminados recientes).
-- `scope_kind/scope_id` acotan el lock a la unidad real (una señal, un
-- cliente, un dominio) en vez del lock global grueso; `updated_at` es el
-- heartbeat de los workers; `error_code` tipa el cierre para la UI
-- (veto del juez ≠ fallo: omisión auditada, no "con errores").
alter table background_runs
  add column if not exists scope_kind text not null default 'global'
    check (scope_kind in ('global', 'signal', 'customer', 'domain')),
  add column if not exists scope_id text,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists error_code text
    check (error_code in ('judge_veto', 'busy', 'llm_fail', 'stale', 'conflict'));

create index if not exists background_runs_store_status_started_idx
  on background_runs (store_id, status, started_at desc);
