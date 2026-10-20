-- item_content multi-tenant (review P2-5): la PK global content_hash dejaba
-- que la misma URL en 2 tiendas pisara store_id ajeno vía onConflict.
-- PK compuesta + onConflict (store_id,content_hash) en el backfill.
-- Ojo: el RENAME de 00002 conserva el nombre original del constraint.
alter table item_content drop constraint media_captions_pkey;
alter table item_content add primary key (store_id, content_hash);
