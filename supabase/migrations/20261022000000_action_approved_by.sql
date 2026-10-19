-- Issue #19 Paso 1: trazabilidad de aprobación (auditoría, sin roles).
-- Quién aprobó un borrador y cuándo; las filas previas quedan en null y la
-- UI las muestra como "aprobado (sin registro)", nunca con un nombre inventado.
alter table proposed_actions
  add column if not exists approved_by text,
  add column if not exists approved_at timestamptz;
