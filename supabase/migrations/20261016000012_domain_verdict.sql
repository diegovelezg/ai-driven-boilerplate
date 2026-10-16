-- El gate B2B (Decisions API, piloto) puede dictaminar que un dominio
-- aparentemente de negocio es en realidad personal: se registra con
-- domain_type='personal' (company_name null) para no re-evaluarlo.
alter table domains drop constraint domains_domain_type_check;
alter table domains
  add constraint domains_domain_type_check
  check (domain_type in ('business', 'institutional', 'personal'));
