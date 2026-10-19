-- Issue #14A: ejes separados en customer_predictions.
-- decision deja de ser el único dato: se persisten los ejes y decision es
-- función pura versionada de ellos (re-ejecutable sobre el pasado).
alter table customer_predictions
  add column if not exists ritmo text
    check (ritmo in ('con-ritmo', 'primera', 'sin-compras')),
  add column if not exists ventana text
    check (ventana in ('antes', 'en', 'pasada', 'dormido')),
  add column if not exists banda_p text
    check (banda_p in ('organico-probable', 'recuperable', 'lejos')),
  add column if not exists valor_decil int
    check (valor_decil between 1 and 10),
  add column if not exists elegibilidad text
    check (elegibilidad in ('ok', 'sin-canal', 'contacto-reciente')),
  add column if not exists decision_version text;

create index if not exists customer_predictions_axes_idx
  on customer_predictions (store_id, ventana, banda_p, elegibilidad);
