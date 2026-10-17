-- Reintentos de enriquecimiento: los fallos fetch+rescue se persisten para no
-- reintentar para siempre en cada corrida automática.
-- failed_attempts cuenta intentos; terminal = domain_type='unreachable'
-- con failed_attempts >= 3 (sale del automático; reintento manual con force=true
-- sigue posible vía reenrichDomainAction).
alter table domains drop constraint domains_domain_type_check;
alter table domains
  add constraint domains_domain_type_check
  check (domain_type in ('business', 'institutional', 'personal', 'unreachable'));

alter table domains add column if not exists failed_attempts int not null default 0;
alter table domains add column if not exists last_error text;
