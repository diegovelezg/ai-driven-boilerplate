-- Sanitización residual: la matriz de exclusión de sys_run_start listaba
-- kinds del motor de retención extirpado en 20221122 (scout, strategist,
-- copywriter, enrichment, prospect y sus variantes *_single/regenerate).
-- Esos kinds ya no se emiten en web/ (solo 'profile' e 'import' siguen
-- vivos), así que sus ramas nunca se disparaban. Se reduce a la regla
-- vigente: 'sync' excluye todo, cualquier otro kind excluye a su gemelo.
create or replace function public.sys_run_start(
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
    select 1 from sys_runs r
    where r.store_id = p_store_id
      and r.status = 'running'
      and (p_kind = 'sync' or r.kind = 'sync' or r.kind = p_kind)
  ) then
    return null;
  end if;

  insert into sys_runs (store_id, kind, label, total, status, scope_kind, scope_id)
  values (p_store_id, p_kind, p_label, p_total, 'running', 'global', null)
  returning id into v_id;

  return v_id;
exception when undefined_column then
  -- DB sin migración de scopes (20261021000000): reintenta legacy.
  insert into sys_runs (store_id, kind, label, total, status)
  values (p_store_id, p_kind, p_label, p_total, 'running')
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.sys_run_start(uuid, text, text, int) from public, anon, authenticated;
grant execute on function public.sys_run_start(uuid, text, text, int) to service_role;
