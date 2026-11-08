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
--    /screens lee background_runs kind=import. Ver web/lib/dooh-import.ts.
-- 3. domains (caché global de firmografía, 20261123): faltaba policy RLS
--    (solo ENABLE RLS). Lectura para authenticated; escritura solo
--    service_role (sin policy de insert/update/delete).
-- Se conservan con su nombre actual (renombres con prefijo en 20261125):
-- play_logs (scaffold etapa 9 PoP/CMS, aún sin writer), campaigns
-- (contenedor comercial; la IO es su documento), store_secret_audits y
-- llm_usage (+llm_usage_daily) como auditoría/metering write-only.

drop table if exists conversations cascade;
drop table if exists messages cascade;

insert into background_runs (store_id, kind, label, total, processed, failed, status, summary, started_at, finished_at)
select store_id, 'import', 'import:' || kind, rows_seen, rows_ok, rows_failed, 'done',
  'import ' || kind || ' ' || source || ': ' || rows_ok || '/' || rows_seen || ' ok'
    || case when rows_failed > 0 then ', ' || rows_failed || ' errores' else '' end,
  created_at, created_at
from import_runs;
drop table if exists import_runs cascade;

create policy domains_read on domains for select to authenticated using (true);
