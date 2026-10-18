-- Filosofía TeamPulse: cada corrida declara su estado final en lenguaje del
-- home (needs = te necesita, active = actuó, paused = pausa intencional).
-- El detalle técnico queda en processed/failed/log; el `summary` es 1 línea
-- humana y `pulse_state` es la SSOT para ordenar needs > active > paused.
alter table background_runs
  add column if not exists pulse_state text
    check (pulse_state in ('needs', 'active', 'paused'));
