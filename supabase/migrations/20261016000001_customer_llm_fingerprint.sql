-- Fingerprint para (re)procesamiento LLM de customers.
-- Regla: re-procesar <=> needs_processing = true.
--
-- input_hash = sha256 canónico de todos los inputs del LLM (perfil + agregados
-- + last_order_at). Lo mantiene el trigger: cubre sync, edits locales y futuras
-- vías sin código extra ni riesgo de divergencia entre implementaciones.
-- processed_hash/processed_at los escribe el worker junto con sus resultados.
-- needs_processing lo deriva el trigger (processed_hash IS DISTINCT FROM input_hash),
-- así la query pendiente es un simple `eq` (PostgREST no compara columna vs columna).

create extension if not exists pgcrypto;

alter table customers
  add column last_order_at timestamptz,
  add column input_hash text not null default '',
  add column processed_hash text,
  add column processed_at timestamptz,
  add column needs_processing boolean not null default true;

create or replace function set_customer_input_hash()
returns trigger language plpgsql as $$
declare
  sep constant text := chr(31);
begin
  NEW.input_hash := encode(digest(
    coalesce(lower(NEW.email), '') || sep ||
    coalesce(NEW.phone, '') || sep ||
    coalesce(NEW.first_name, '') || sep ||
    coalesce(NEW.last_name, '') || sep ||
    coalesce(NEW.company_name, '') || sep ||
    coalesce(NEW.customer_type, '') || sep ||
    coalesce(NEW.orders_count::text, '') || sep ||
    coalesce(NEW.total_spent::text, '') || sep ||
    coalesce(lower(NEW.currency), '') || sep ||
    coalesce(NEW.last_order_at::text, '')
  , 'sha256'), 'hex');
  NEW.needs_processing := (NEW.processed_hash is distinct from NEW.input_hash);
  return NEW;
end $$;

create trigger customers_input_hash
  before insert or update on customers
  for each row execute function set_customer_input_hash();

-- Backfill one-time: recalcula hash + pendiente de filas existentes.
update customers set email = email where input_hash = '';

create index customers_needs_processing_idx
  on customers (store_id)
  where (needs_processing);
