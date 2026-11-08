-- Datos de pauta por pantalla: reproducciones por día + duración del spot.
-- `duration_sec` ya existe (catálogo Perú); se agrega `plays_per_day`
-- (cantidad de reproducciones/emisiones por día) editable desde la ficha.
alter table inv_screens
  add column if not exists plays_per_day int check (plays_per_day is null or plays_per_day > 0);
