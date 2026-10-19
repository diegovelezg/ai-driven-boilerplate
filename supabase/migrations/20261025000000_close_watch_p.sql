-- Corte p de "seguimiento cercano" por tenant (issue #21 Paso 1).
-- Solo display: NULL => default 0.10 (documentado, no fitted).
alter table store_profiles
  add column if not exists close_watch_p float
    check (close_watch_p is null or (close_watch_p >= 0 and close_watch_p <= 1));
