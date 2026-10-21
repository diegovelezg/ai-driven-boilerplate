-- TenantBrain mínimo (issue #25 Hito 1): snapshot diario agnóstico en store_profiles.
-- Lo escribe 1 job/día (morning-run); lo leen writer/juez/prospect (1 query, sin N+1).
alter table store_profiles add column if not exists brain_json jsonb;
