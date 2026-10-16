-- Perfil del tenant + arquetipo de churn (Fase 1b).
-- Un perfil por store (1:1). El sync nunca lo toca (upsert solo en stores).
-- business_model = a quién vende el tenant (≠ customer_type por fila).
-- archetype = patrón derivado que Fase 2 usará para ventanas de churn,
-- campos requeridos y tono de mensajes.

create table store_profiles (
  store_id uuid primary key references stores (id) on delete cascade,
  business_model text not null default 'b2c'
    check (business_model in ('b2c', 'b2b', 'hybrid')),
  industry text,                       -- alimentos | moda | belleza | hogar | electronica | salud | mascotas | servicios | distribucion | otro
  catalog_type text                     -- consumible | perecedero | moda_estacional | durable | servicio | digital | mixto
    check (catalog_type is null or catalog_type in
      ('consumible', 'perecedero', 'moda_estacional', 'durable', 'servicio', 'digital', 'mixto')),
  -- Ciclo de recompra declarado por el merchant (días). Null = auto (mediana de intervalos Fase 2).
  repurchase_cycle_days int check (repurchase_cycle_days is null or repurchase_cycle_days between 1 and 1095),
  -- Multiplicador de churn: alerta cuando inactividad > ciclo * multiplicador. Default 1.25 (README §4).
  churn_multiplier numeric(4,2) not null default 1.25
    check (churn_multiplier between 1.0 and 5.0),
  -- Arquetipo vigente + cómo se fijó (manual = merchant, sugerido = aceptó heurística, auto = sin datos).
  archetype text not null default 'b2c_consumible'
    check (archetype in
      ('b2c_consumible', 'b2c_moda', 'b2c_durable', 'b2b_recurrente', 'b2b_proyecto', 'hibrido')),
  archetype_source text not null default 'auto'
    check (archetype_source in ('manual', 'sugerido', 'auto')),
  -- Si true, company_name pasa a ser campo esperado en customers (B2B).
  company_required boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger store_profiles_updated_at
  before update on store_profiles
  for each row execute function set_updated_at();

alter table store_profiles enable row level security;
