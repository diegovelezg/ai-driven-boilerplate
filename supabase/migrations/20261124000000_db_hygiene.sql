-- Higiene post-pivote DOOH (review profundo 2026-11).
-- Decisiones:
-- 1. conversations/messages: DROP. Memoria del chat del motor ecommerce
--    (customer_id → customers, tabla extirpada en 20261122). 0 lectores y
--    0 escritores en web/ (saveTurn/loadHistory sin llamadas; los chats
--    activos declaran "sin memoria persistida"). Si el chat de fichas
--    necesita memoria, recrear claveada a (store_id, company_id).
-- 2. import_runs: DROP con traspaso previo a background_runs (se renombra
--    a sys_runs en 20261125). Un solo sistema de runs: kind='import',
--    label 'import:<kind>', summary en una línea (columna TEXT).
--    El traspaso es idempotente ante el renombre ya aplicado: si el entorno
--    ya renombró background_runs→sys_runs (o no tiene import_runs), escribe
--    en la tabla viva que exista y no falla.
--    /screens lee kind=import. Ver web/lib/dooh-import.ts.
-- 3. domains (caché global de firmografía, 20261123): faltaba policy RLS
--    (solo ENABLE RLS). Lectura para authenticated; escritura solo
--    service_role (sin policy de insert/update/delete).
-- Se conservan con su nombre actual (renombres con prefijo en 20261125):
-- play_logs (scaffold etapa 9 PoP/CMS, aún sin writer), campaigns
-- (contenedor comercial; la IO es su documento), store_secret_audits y
-- llm_usage (+llm_usage_daily) como auditoría/metering write-only.

-- Política DROP seguro (AGENTS.md): pre-chequeo RAISE antes de borrar.
do $$
declare n int;
begin
  select count(*) into n from public.conversations;
  if n > 0 then
    raise exception 'DROP bloqueado: public.conversations tiene % filas; crear _backup o migrar antes', n;
  end if;
end $$;
drop table if exists conversations cascade;
do $$
declare n int;
begin
  select count(*) into n from public.messages;
  if n > 0 then
    raise exception 'DROP bloqueado: public.messages tiene % filas; crear _backup o migrar antes', n;
  end if;
end $$;
drop table if exists messages cascade;

do $$
begin
  -- Traspaso idempotente (ver comentario §2): en replay fresco existe
  -- background_runs; en entornos ya renombrados, sys_runs; sin import_runs,
  -- no hay nada que mover y solo se limpian las tablas de chat.
  if to_regclass('public.import_runs') is not null then
    if to_regclass('public.background_runs') is not null then
      insert into background_runs (store_id, kind, label, total, processed, failed, status, summary, started_at, finished_at)
      select store_id, 'import', 'import:' || kind, rows_seen, rows_ok, rows_failed, 'done',
        'import ' || kind || ' ' || source || ': ' || rows_ok || '/' || rows_seen || ' ok'
          || case when rows_failed > 0 then ', ' || rows_failed || ' errores' else '' end,
        created_at, created_at
      from import_runs;
    elsif to_regclass('public.sys_runs') is not null then
      insert into sys_runs (store_id, kind, label, total, processed, failed, status, summary, started_at, finished_at)
      select store_id, 'import', 'import:' || kind, rows_seen, rows_ok, rows_failed, 'done',
        'import ' || kind || ' ' || source || ': ' || rows_ok || '/' || rows_seen || ' ok'
          || case when rows_failed > 0 then ', ' || rows_failed || ' errores' else '' end,
        created_at, created_at
      from import_runs;
    end if;
    -- DROP con guarda: import_runs ya traspasada arriba; si quedó algo, aborta.
    do $inner$
    declare n int;
    begin
      select count(*) into n from public.import_runs;
      if n > 0 then
        raise exception 'DROP bloqueado: public.import_runs tiene % filas sin traspasar', n;
      end if;
    end $inner$;
    drop table if exists import_runs cascade;
  end if;
end $$;

create policy domains_read on domains for select to authenticated using (true);
