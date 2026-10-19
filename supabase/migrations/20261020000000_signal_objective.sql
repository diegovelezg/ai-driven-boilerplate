-- Issue #11 P1: separar signal_kind (origen detector) de objective (tratamiento).
-- Scout escribe kind una vez al crear; strategist escribe objective sin pisar kind.
alter table churn_signals
  add column if not exists objective text
    check (objective in ('winback', 'nurture', 'vip_care'));

create index if not exists churn_signals_store_objective_idx
  on churn_signals (store_id, objective, status);
