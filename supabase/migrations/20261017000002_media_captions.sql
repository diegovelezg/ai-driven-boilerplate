-- Captions Nivel 1 (visión) de piezas subidas por clientes (media_file de Medusa).
-- Clave = sha256 hex de media_url (dedup: mismo creativo en N pantallas = 1 caption).
-- Tabla separada de orders.items_json a propósito: el sync re-escribe items_json
-- desde el raw de Medusa en cada corrida; aquí el caption sobrevive.
-- NUNCA guardar captions en metadata.media_comments: esa key la escribe Medusa
-- con lo que teclea el usuario (fuente humana, debe quedar pura).
create table media_captions (
  media_hash text primary key,
  store_id uuid not null references stores (id) on delete cascade,
  media_url text not null,
  media_kind text not null check (media_kind in ('video', 'image')),
  caption_json jsonb,
  model text,
  alive boolean not null default true,   -- false = la URL ya no existe en S3 (NoSuchKey)
  captioned_at timestamptz not null default now()
);
create index media_captions_store_idx on media_captions (store_id);

alter table media_captions enable row level security;
create policy tenant_isolation on media_captions
  for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
