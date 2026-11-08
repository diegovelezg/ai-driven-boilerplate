-- sys_secrets + sys_secret_audits: DROP. Infra del Email transaccional
-- (SendGrid) cuyo único consumidor (settings Email + lib/store*) se eliminó.
-- 0 referencias en web/. Sin estas tablas no hay dónde guardar keys: si el
-- Email vuelve, se recrean con el nuevo diseño (ver git history).
drop table if exists sys_secret_audits cascade;
drop table if exists sys_secrets cascade;
