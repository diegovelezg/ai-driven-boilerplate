-- Slot atómico de corridas (issue #24, review P2): el patrón
-- `hasConflict` → `startRun` es TOCTOU entre réplicas del worker (el claim
-- SKIP LOCKED evita reclamar el MISMO job dos veces, pero dos jobs DISTINTOS
-- del mismo kind pasan el check a la vez e inician runs duplicados).
-- `start_run_if_free` hace check+insert en una sola transacción con advisory
-- lock por store: devuelve el run id o NULL si hay ocupación.
--
-- La regla de conflicto replica `lib/operations.ts conflictsWith` para un
-- arranque GLOBAL (el worker siempre arranca global): `sync` bloquea todo,
-- la cadena scout/strategist/copywriter es secuencial, y los LONE
-- (enrichment, prospect) no se duplican a sí mismos. Para los kinds puntuales
-- (`*_single`, `regenerate`) es conservadora a propósito.
create or replace function public.start_run_if_free(
  p_store_id uuid,
  p_kind text,
  p_label text,
  p_total int default 0
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- Serializa check+insert entre réplicas (se libera al commit).
  perform pg_advisory_xact_lock(hashtext('run-slot:' || p_store_id::text));

  if exists (
    select 1 from background_runs r
    where r.store_id = p_store_id
      and r.status = 'running'
      and (
        p_kind = 'sync' or r.kind = 'sync'
        or r.kind = p_kind
        or (p_kind in ('scout', 'strategist', 'copywriter')
            and r.kind in ('scout', 'strategist', 'copywriter'))
        or (p_kind = 'copywriter' and r.kind in ('copywriter_single', 'regenerate'))
        or (p_kind in ('copywriter_single', 'regenerate') and r.kind = 'copywriter')
        or (p_kind = 'regenerate' and r.kind = 'regenerate')
        or (p_kind = 'enrichment' and r.kind = 'enrich_single')
        or (p_kind = 'enrich_single' and r.kind = 'enrichment')
      )
  ) then
    return null;
  end if;

  insert into background_runs (store_id, kind, label, total, status, scope_kind, scope_id)
  values (p_store_id, p_kind, p_label, p_total, 'running', 'global', null)
  returning id into v_id;

  return v_id;
exception when undefined_column then
  -- DB sin migración de scopes (20261021000000): reintenta legacy.
  insert into background_runs (store_id, kind, label, total, status)
  values (p_store_id, p_kind, p_label, p_total, 'running')
  returning id into v_id;
  return v_id;
end;
$$;

-- Solo service_role (worker + server actions): ejecutable por PUBLIC sería
-- ocupable por cualquier authenticated (DoS del slot).
revoke all on function public.start_run_if_free(uuid, text, text, int) from public, anon, authenticated;
grant execute on function public.start_run_if_free(uuid, text, text, int) to service_role;
