-- pgcrypto vive en el schema `extensions` (imagen Supabase), pero el trigger
-- de customers se ejecuta con el search_path de la sesión. En restores
-- (pg_dump resetea search_path a '') y en conexiones que no incluyen
-- `extensions`, digest() no resuelve. Lo fijamos en la función.
create extension if not exists pgcrypto with schema extensions;

create or replace function set_customer_input_hash()
returns trigger language plpgsql
set search_path = public, extensions
as $$
declare
  sep constant text := chr(31);
  eff_phone constant text := coalesce(nullif(NEW.manual_edits->>'phone', ''), NEW.phone, '');
  eff_first constant text := coalesce(nullif(NEW.manual_edits->>'first_name', ''), NEW.first_name, '');
  eff_last constant text := coalesce(nullif(NEW.manual_edits->>'last_name', ''), NEW.last_name, '');
  eff_company constant text := coalesce(nullif(NEW.manual_edits->>'company_name', ''), NEW.company_name, '');
  eff_type constant text := coalesce(nullif(NEW.manual_edits->>'customer_type', ''), NEW.customer_type, '');
begin
  NEW.input_hash := encode(digest(
    coalesce(lower(NEW.email), '') || sep ||
    eff_phone || sep ||
    eff_first || sep ||
    eff_last || sep ||
    eff_company || sep ||
    eff_type || sep ||
    coalesce(NEW.orders_count::text, '') || sep ||
    coalesce(NEW.total_spent::text, '') || sep ||
    coalesce(lower(NEW.currency), '') || sep ||
    coalesce(NEW.last_order_at::text, '')
  , 'sha256'), 'hex');
  NEW.needs_processing := (NEW.processed_hash is distinct from NEW.input_hash);
  return NEW;
end $$;
