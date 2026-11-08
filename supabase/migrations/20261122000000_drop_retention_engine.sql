-- Fase 2 directa: extirpa motor de retención. DOOH es gestión comercial
-- (companies/contacts/venues/screens/slots/IOs), no recompra probabilística.
-- Retención en cero filas: sin datos que migrar.
-- Se conservan: stores, companies, contacts, venues, screens, loop_templates,
-- inventory_slots, campaigns, bookings, insertion_orders(+lines), agency_orders,
-- creatives, photo_checks, play_logs, invoices, import_runs, background_runs,
-- order_counters, merchant_users, store_profiles (config negocio), store_secrets,
-- conversations/messages, vertical_profiles (caché del perfilador de negocio),
-- llm_usage (metering vivo de los wrappers de modelos).

-- Hijas primero por FK.
drop table if exists proposed_actions cascade;
drop table if exists churn_signals cascade;
drop table if exists proposed_leads cascade;
drop table if exists customer_predictions cascade;
drop table if exists tenant_model_params cascade;
drop table if exists opt_outs cascade;
drop table if exists enrichment_runs cascade;
drop table if exists domains cascade;
drop table if exists customer_aliases cascade;
drop table if exists item_content cascade;
drop table if exists media_captions cascade;
drop table if exists product_stats cascade;
drop table if exists products cascade;
drop table if exists profile_proposals cascade;
drop table if exists profile_snapshots cascade;

-- Ecommerce legacy (DOOH usa companies/contacts/insertion_orders, no esto).
drop table if exists orders cascade;
drop table if exists customers cascade;
drop table if exists channels cascade;
drop table if exists market_regions cascade;

-- Muertos sin lectores: log de sync-en-login (era Medusa) y artefacto jobs.
drop table if exists login_sync_decisions cascade;
drop table if exists jobs cascade;

-- Columnas del motor en store_profiles (la tabla se conserva para config negocio).
alter table store_profiles drop column if exists brain_json;
alter table store_profiles drop column if exists icp_description;
alter table store_profiles drop column if exists metadata_map;
alter table store_profiles drop column if exists close_watch_p;
alter table store_profiles drop column if exists p_band_high;
alter table store_profiles drop column if exists p_band_low;
alter table store_profiles drop column if exists p_band_calibrated_at;
alter table store_profiles drop column if exists p_band_samples;

-- Funciones huérfanas del motor (triggers mueren con sus tablas por cascade).
drop function if exists set_customer_input_hash() cascade;
drop function if exists check_product_stats_tenancy() cascade;
drop function if exists set_product_is_active() cascade;
drop function if exists public.search_content_customers(uuid, text, integer, text) cascade;
drop function if exists implicit_market_country(text[], text) cascade;
drop function if exists public.content_text(jsonb) cascade;
