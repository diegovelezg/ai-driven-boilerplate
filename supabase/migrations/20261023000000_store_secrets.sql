-- Issue #20: secrets (API keys/tokens) en DB cifrada, no en .data/connections.json.
-- Cifrado a nivel app (AES-256-GCM, ver web/lib/secrets-crypto.ts): la DB solo
-- guarda texto cifrado `v1.<iv>.<tag>.<ct>`. Nunca plaintext.
-- Escritura/lectura solo service_role (server-only via web/lib/store-secrets.ts).
-- Sin policies para authenticated = denegado por defecto (bypassa service_role).
-- Auditoría básica en store_secret_audits (quién/cuándo, sin valor): lectura
-- tenant-scoped para authenticated (mismo patrón que llm_usage).

create table store_secrets (
  store_id uuid not null references stores (id) on delete cascade,
  key_name text not null check (key_name in ('medusa_token', 'shopify_token', 'email_api_key')),
  encrypted_value text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (store_id, key_name)
);

alter table store_secrets enable row level security;
-- Sin policies: solo service_role (el server) lee/escribe. Ningún merchant
-- lee el cifrado directo por PostgREST.

create index store_secrets_store_idx on store_secrets (store_id);

create table store_secret_audits (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  key_name text not null,
  action text not null check (action in ('upsert', 'revoke', 'migrate')),
  key_fingerprint text null,
  actor text null,
  created_at timestamptz not null default now()
);

alter table store_secret_audits enable row level security;

-- El merchant ve cuándo/quién rotó cada key de su tienda (sin valores).
create policy tenant_isolation on store_secret_audits
  for select to authenticated using (public.is_store_member(store_id));

create index store_secret_audits_store_created_idx
  on store_secret_audits (store_id, created_at desc);
