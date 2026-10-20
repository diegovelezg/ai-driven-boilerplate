-- Rename tenant-acoplado → genérico (tabla vacía en prod: 0 filas).
-- media_captions → item_content: el contenido Nivel 1 por línea de compra
-- (caption IA, catálogo, booking…) vive aquí sea cual sea el tipo de negocio.
-- ORDEN: corre tras 20261017000002_media_captions (crea la tabla) y ANTES de
-- 20261030000003 (dropea el overload viejo). No aplicar standalone: los
-- RENAME asumen la tabla/constraints originales (nombres media_captions_*).
alter table media_captions rename to item_content;
alter table item_content rename column media_hash to content_hash;
alter table item_content rename column media_url to content_url;
alter table item_content rename column media_kind to content_kind;
alter table item_content rename column caption_json to content_json;
alter index media_captions_store_idx rename to item_content_store_idx;

-- Limpieza del nombre viejo (la app ya no lo llama): primero el índice que
-- depende de la función, luego la función.
drop index if exists media_captions_trgm_idx;
drop function if exists public.caption_text(jsonb);

-- Función con nombre genérico (antes del índice que la usa).
create or replace function public.content_text(c jsonb)
returns text language sql immutable as $$
  select coalesce(c->>'marca', '') || ' ' || coalesce(c->>'que_anuncia', '') || ' ' ||
         coalesce(c->>'categoria', '') || ' ' || coalesce(c->>'texto_visible', '');
$$;

-- Índice genérico (el WHERE y el cuerpo cambiaron con el rename).
create index if not exists item_content_trgm_idx on item_content
  using gin (public.content_text(content_json) gin_trgm_ops)
  where content_json is not null;

-- search_content_customers: misma firma + p_file_key (la key del archivo en
-- metadata varía por tipo de negocio; default = preset DOOH).
create or replace function public.search_content_customers(
  p_store uuid, p_term text, p_limit int default 40, p_file_key text default 'media_file'
)
returns table (customer_id uuid, marca text, que text, categoria text, score real)
language sql stable security definer set search_path = public as $$
  with matched as (
    select m.content_url,
           (m.content_json->>'marca') as marca,
           (m.content_json->>'que_anuncia') as que,
           (m.content_json->>'categoria') as categoria,
           greatest(
             similarity(coalesce(m.content_json->>'marca', ''), p_term),
             similarity(coalesce(m.content_json->>'que_anuncia', ''), p_term),
             similarity(coalesce(m.content_json->>'categoria', ''), p_term),
             word_similarity(coalesce(m.content_json->>'texto_visible', ''), p_term)
           ) as sim
    from item_content m
    where m.store_id = p_store
      and m.content_json is not null
      and (
        coalesce(m.content_json->>'marca', '') % p_term
        or coalesce(m.content_json->>'que_anuncia', '') % p_term
        or coalesce(m.content_json->>'categoria', '') % p_term
        or coalesce(m.content_json->>'texto_visible', '') <% p_term
      )
    order by sim desc
    limit p_limit
  )
  select distinct on (o.customer_id)
    o.customer_id, mt.marca, mt.que, mt.categoria, mt.sim
  from matched mt
  join orders o on o.store_id = p_store
    and exists (
      select 1 from jsonb_array_elements(o.items_json) it
      where it->'metadata'->>p_file_key = mt.content_url
    )
  order by o.customer_id, mt.sim desc;
$$;

grant execute on function public.content_text(jsonb) to authenticated, service_role;
grant execute on function public.search_content_customers(uuid, text, int, text) to authenticated, service_role;
