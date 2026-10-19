-- Estado de autocalibración de bandas por tenant (multitenant, cadencia 30d).
-- Sin esto el throttle de 30 días viviría en archivos locales (.data): con N
-- tenants y N réplicas, cada réplica recalibraría por su cuenta. El estado va
-- en Postgres junto a los valores, como close_watch_p.
alter table store_profiles
  add column if not exists p_band_calibrated_at timestamptz,
  add column if not exists p_band_samples int
    check (p_band_samples is null or p_band_samples >= 0),
  add column if not exists p_band_events int
    check (p_band_events is null or p_band_events >= 0);
