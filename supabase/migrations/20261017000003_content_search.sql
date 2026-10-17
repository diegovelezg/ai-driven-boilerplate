-- Búsqueda fuzzy de contenido pautado (captions Nivel 1): un solo mecanismo
-- para GUI y agentes. pg_trgm maneja apóstrofes, plurales y typos
-- ("angel nails" ≈ "Angel's Nails") sin reglas ad-hoc en la app.
create extension if not exists pg_trgm;

-- Texto combinado del caption (inmutable para poder indexarlo).
create or replace function public.caption_text(c jsonb)
returns text language sql immutable as $$
  select coalesce(c->>'marca', '') || ' ' || coalesce(c->>'que_anuncia', '') || ' ' ||
         coalesce(c->>'categoria', '') || ' ' || coalesce(c->>'texto_visible', '');
$$;

create index if not exists media_captions_trgm_idx on media_captions
  using gin (public.caption_text(caption_json) gin_trgm_ops)
  where caption_json is not null;

-- Customers cuyo contenido pautado matchea el término (fuzzy).
-- Por campo (no combinado): evita que el texto largo diluya el score.
create or replace function public.search_content_customers(p_store uuid, p_term text, p_limit int default 40)
returns table (customer_id uuid, marca text, que text, categoria text, score real)
language sql stable security definer set search_path = public as $$
  with matched as (
    select m.media_url,
           (m.caption_json->>'marca') as marca,
           (m.caption_json->>'que_anuncia') as que,
           (m.caption_json->>'categoria') as categoria,
           greatest(
             similarity(coalesce(m.caption_json->>'marca', ''), p_term),
             similarity(coalesce(m.caption_json->>'que_anuncia', ''), p_term),
             similarity(coalesce(m.caption_json->>'categoria', ''), p_term),
             word_similarity(coalesce(m.caption_json->>'texto_visible', ''), p_term)
           ) as sim
    from media_captions m
    where m.store_id = p_store
      and m.caption_json is not null
      and (
        coalesce(m.caption_json->>'marca', '') % p_term
        or coalesce(m.caption_json->>'que_anuncia', '') % p_term
        or coalesce(m.caption_json->>'categoria', '') % p_term
        or coalesce(m.caption_json->>'texto_visible', '') <% p_term
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
      where it->'metadata'->>'media_file' = mt.media_url
    )
  order by o.customer_id, mt.sim desc;
$$;

grant execute on function public.caption_text(jsonb) to authenticated, service_role;
grant execute on function public.search_content_customers(uuid, text, int) to authenticated, service_role;
