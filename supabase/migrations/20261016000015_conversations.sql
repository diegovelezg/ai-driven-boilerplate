-- Persistencia de conversación (Fase A, deuda issue #2): la sesión ADK es
-- in-memory y se pierde con cada reinicio/HMR. Una conversación por customer
-- (upsert por store+customer) + sus turnos; la ruta de chat la usa como
-- memoria entre reinicios (el historial del cliente sigue como fallback).
create table conversations (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references stores (id) on delete cascade,
  customer_id uuid not null references customers (id) on delete cascade,
  view        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (store_id, customer_id)
);

create table messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations (id) on delete cascade,
  role            text not null check (role in ('user', 'model')),
  content         text not null,
  created_at      timestamptz not null default now()
);
create index messages_conversation_idx
  on messages (conversation_id, created_at);

alter table conversations enable row level security;
alter table messages enable row level security;

create trigger conversations_updated_at
  before update on conversations
  for each row execute function set_updated_at();
