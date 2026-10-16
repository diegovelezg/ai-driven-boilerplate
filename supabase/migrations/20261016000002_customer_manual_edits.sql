-- Overrides manuales de customers (edición inline + modal).
--
-- Problema: el sync hace upsert completo desde Medusa; editar las columnas base
-- se perdería en el próximo sync. Solución: overlay `manual_edits` (jsonb) que
-- el sync nunca toca. Lectura = override ?? base ("gana lo local").
-- El trigger hashea los valores EFECTIVOS, así una edición dispara needs_processing
-- y el LLM ve lo mismo que la UI. Filas existentes tienen '{}' => hash idéntico,
-- sin reprocesos fantasma ni backfill.
-- Claves válidas: first_name, last_name, phone, company_name, customer_type.
-- (email es el identificador y no es editable).

alter table customers
  add column manual_edits jsonb not null default '{}';

create or replace function set_customer_input_hash()
returns trigger language plpgsql as $$
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
