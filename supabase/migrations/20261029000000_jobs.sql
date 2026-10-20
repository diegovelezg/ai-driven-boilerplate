-- RETIRADA (corte sin-cola): no-op intencional, cero statements.
-- La web corre runSyncOnce directo y el worker es cron de una pasada.
-- En DBs existentes la tabla `jobs` queda como artefacto histórico ignorado
-- (nadie la lee ni escribe). En fresh no se crea nada.
-- DROP futuro de la tabla huérfana cuando ningún deploy viejo pueda encolar.
-- (Historial: issue #24 — queue transaccional en Postgres con claim
-- FOR UPDATE SKIP LOCKED, retries con backoff + DLQ, idempotencia por
-- (store_id, idempotency_key). Reemplazada por ejecución directa + slot.)
select 1;
