-- Cortes de banda_p por tenant (issue #21 Paso 5).
-- Forma global y versionada; valores por tenant con fallback al default del
-- arquetipo (hoy 0.6/0.15 en todos ⇒ reproduce v2). NULL = default.
alter table store_profiles
  add column if not exists p_band_high float
    check (p_band_high is null or (p_band_high > 0 and p_band_high < 1)),
  add column if not exists p_band_low float
    check (p_band_low is null or (p_band_low >= 0 and p_band_low < 1));
