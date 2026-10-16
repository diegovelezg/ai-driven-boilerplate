-- Descripción libre del negocio (entrada orgánica) + metadata de interpretación.
-- La descripción es la fuente primaria; los campos estructurados se derivan de
-- ella (intérprete local hoy, LLM mañana) y el merchant los confirma en Settings.
-- archetype_source existente distingue manual/sugerido; interpreted_at dice cuándo
-- se interpretó por última vez.

alter table store_profiles
  add column description text,
  add column interpretation_confidence text
    check (interpretation_confidence is null or interpretation_confidence in ('alta', 'media', 'baja')),
  add column interpreted_at timestamptz;
