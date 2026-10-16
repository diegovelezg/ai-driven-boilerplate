-- Loop de retención: señales de churn (scout/strategist) y acciones propuestas
-- (copywriter → aprobación humana → dispatcher → analyst). Fase A.
create table churn_signals (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references stores (id) on delete cascade,
  customer_id uuid not null references customers (id) on delete cascade,
  kind        text not null,                 -- 'churn_risk' | 'winback' | 'vip_care' | 'nurture'
  score       float,                         -- 0..1, fuerza de la señal (scout)
  reason      text,                          -- motivo legible: 'sin comprar hace 45d (media 30d)'
  status      text not null default 'open'
    check (status in ('open', 'prioritized', 'actioned', 'closed', 'dismissed')),
  created_at  timestamptz not null default now(),
  closed_at   timestamptz
);

alter table churn_signals enable row level security;
create index churn_signals_store_status_idx
  on churn_signals (store_id, status, created_at desc);
create index churn_signals_customer_idx
  on churn_signals (customer_id, created_at desc);

create table proposed_actions (
  id                 uuid primary key default gen_random_uuid(),
  store_id           uuid not null references stores (id) on delete cascade,
  customer_id        uuid not null references customers (id) on delete cascade,
  signal_id          uuid references churn_signals (id) on delete set null,
  channel            text not null
    check (channel in ('whatsapp', 'email')),
  subject            text,                    -- solo email
  body               text not null,           -- mensaje redactado por copywriter
  status             text not null default 'pending_review'
    check (status in ('pending_review', 'approved', 'rejected', 'dispatched', 'failed')),
  revenue_attributed numeric(12, 2),         -- lo rellena analyst si el cliente volvió
  created_at         timestamptz not null default now(),
  dispatched_at      timestamptz
);

alter table proposed_actions enable row level security;
create index proposed_actions_store_status_idx
  on proposed_actions (store_id, status, created_at desc);
create index proposed_actions_customer_idx
  on proposed_actions (customer_id, created_at desc);
