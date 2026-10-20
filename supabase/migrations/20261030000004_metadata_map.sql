-- Mapeo de metadata por tenant (human-in-the-loop): el merchant dice qué key
-- de sus transactions es archivo/comentario/fechas. El sync nunca lo toca.
-- 0 o 1 key por rol; lo no-mapeado cae a `detalles` o a `ignore`.
alter table store_profiles add column metadata_map jsonb;
