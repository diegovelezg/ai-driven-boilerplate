-- sys_store_profiles: poda de columnas legacy por diseño (no por uso).
-- Se conservan los 9 conceptos vivos del profiler actual
-- (business_model, industry, catalog_type, archetype, company_required,
-- description, vertical_detected, taxonomy_id, buyer_type + base).
-- Se eliminan:
-- - repurchase_cycle_days: ancla del motor de retención extirpado (el
--   profiler razona ciclo cualitativamente en memoria, no persiste el entero).
-- - churn_multiplier, p_band_events: calibración del motor muerto.
-- - archetype_source, manual_slots, interpretation_confidence,
--   interpreted_at, notes: bookkeeping del form manual borrado y del loop
--   de recalibración (0 lectores vivos; notes era carta muerta).
alter table sys_store_profiles
  drop column if exists repurchase_cycle_days,
  drop column if exists churn_multiplier,
  drop column if exists archetype_source,
  drop column if exists manual_slots,
  drop column if exists interpretation_confidence,
  drop column if exists interpreted_at,
  drop column if exists p_band_events,
  drop column if exists notes;
