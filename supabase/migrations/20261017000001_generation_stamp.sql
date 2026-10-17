-- Sello de generación (write-time): con qué criterios nació cada fila.
-- Permite reproceso independiente por etapa: criterio nuevo → solo filas
-- nuevas llevan sello nuevo; lo viejo se regenera con acción explícita.
alter table proposed_actions
  add column evidence_json jsonb; -- {generator, run_id, catalog, at}
alter table churn_signals
  add column evidence_json jsonb; -- {generator, run_id, at}
