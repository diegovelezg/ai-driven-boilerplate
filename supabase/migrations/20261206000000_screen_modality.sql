-- Modalidad de pantalla: digital (video, con pauta) o impresa (estática,
-- sin reproducciones ni duración de spot). Todo el inventario actual es digital.
alter table inv_screens
  add column if not exists modality text not null default 'digital'
  check (modality in ('digital', 'static'));
