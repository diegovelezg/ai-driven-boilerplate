-- Espacios vendibles por pantalla y día (slots por pantalla).
-- Columna por tenant con default 10: 1 slot = 1 espacio vendible el mismo día
-- en la misma pantalla. Fallback cuando la pantalla no tiene slots explícitos
-- (inv_slots) ni loop_template (max_slots). Aditiva: sin DROP, sin backfill
-- destructivo (el default cubre filas existentes).
alter table sys_stores
  add column if not exists default_slots_per_screen int not null default 10
  check (default_slots_per_screen >= 1 and default_slots_per_screen <= 100);
