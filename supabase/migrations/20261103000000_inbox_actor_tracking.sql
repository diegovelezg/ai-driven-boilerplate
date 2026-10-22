-- Tracking multiuser del inbox: quién rechazó/descartó/contactó/cerró y cuándo.
-- Sigue el patrón de `approved_by/at` (issue #19): columnas para estados
-- terminales (filtrables en UI), `evidence_json` para pasos intermedios
-- (revoke/reopen → vuelve a pendiente). Filas previas quedan en null y la UI
-- muestra "sin registro", nunca un nombre inventado.
alter table proposed_actions
  add column if not exists rejected_by text,
  add column if not exists rejected_at timestamptz;

alter table proposed_leads
  add column if not exists decided_by text,
  add column if not exists decided_at timestamptz,
  add column if not exists contacted_by text,
  add column if not exists contacted_at timestamptz;

-- `closed_at` ya existe: `closed_by` dice quién descartó la señal.
alter table churn_signals
  add column if not exists closed_by text;
