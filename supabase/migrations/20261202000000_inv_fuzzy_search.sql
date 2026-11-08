-- Búsqueda fuzzy en inventario (opción B): pg_trgm + unaccent + RPC con ranking.
-- Un solo roundtrip: filtra, rankea, ordena y pagina en Postgres.
-- El `or` de PostgREST no cruza el join screens→venues→companies; el RPC sí.
-- Deploy seguro: screens-db.ts usa el RPC si existe y cae al filtro JS si no.

create extension if not exists pg_trgm with schema public;
create extension if not exists unaccent with schema public;

-- unaccent es STABLE: este wrapper IMMUTABLE permite índices de expresión.
create or replace function public.imm_unaccent(s text)
returns text
language sql
immutable
parallel safe
strict
as $$ select public.unaccent($1) $$;

-- Trigramas para LIKE '%tok%' + operador % (typos). Las búsquedas normalizan
-- con lower(imm_unaccent(col)): tildes y mayúsculas dejan de importar.
create index if not exists inv_screens_name_trgm
  on inv_screens using gin (lower(public.imm_unaccent(name)) gin_trgm_ops);
create index if not exists inv_screens_ref_trgm
  on inv_screens using gin (lower(public.imm_unaccent(external_ref)) gin_trgm_ops);
create index if not exists inv_venues_search_trgm
  on inv_venues using gin (
    (lower(public.imm_unaccent(coalesce(name, '') || ' ' || coalesce(district, '') || ' ' || coalesce(city, '')))) gin_trgm_ops
  );
create index if not exists crm_companies_name_trgm
  on crm_companies using gin (lower(public.imm_unaccent(name)) gin_trgm_ops);

create or replace function public.inv_search_screens(
  p_store uuid,
  p_q text default null,
  p_supplier uuid default null,
  p_city text default null,
  p_active text default 'all',
  p_sort text default 'name',
  p_dir text default 'asc',
  p_limit int default 20,
  p_offset int default 0
)
returns table (
  id uuid,
  name text,
  is_active boolean,
  width_px int,
  height_px int,
  width_m numeric,
  height_m numeric,
  price_pen numeric,
  impact_day int,
  impressions_day int,
  district text,
  city text,
  venue_name text,
  supplier_company_id uuid,
  supplier_name text,
  external_ref text,
  score real,
  total bigint
)
language plpgsql
stable
security definer
set search_path = public
as $func$
declare
  v_qnorm text := null;
  v_citynorm text := null;
  v_active text := 'all';
  v_tokens text[] := '{}';
  v_where text;
  v_order text;
  v_sql text;
  v_t text;
  v_esc text;
  v_tconds text[];
  v_or text;
  v_sim text[];
  v_col text;
  v_cols text[] := array[
    'lower(public.imm_unaccent(s.name))',
    'lower(public.imm_unaccent(s.external_ref))',
    'lower(public.imm_unaccent(v.name))',
    'lower(public.imm_unaccent(v.district))',
    'lower(public.imm_unaccent(v.city))',
    'lower(public.imm_unaccent(c.name))'
  ];
begin
  p_limit := greatest(1, least(coalesce(p_limit, 20), 100));
  p_offset := greatest(0, coalesce(p_offset, 0));
  if p_sort is null or p_sort not in ('name', 'supplier', 'city', 'impact', 'price') then
    p_sort := 'name';
  end if;
  if p_dir is null or p_dir not in ('asc', 'desc') then
    p_dir := 'asc';
  end if;
  if p_active in ('active', 'inactive') then
    v_active := p_active;
  end if;
  if coalesce(btrim(p_city), '') <> '' then
    v_citynorm := lower(public.imm_unaccent(p_city));
  end if;

  -- $1..$4 fijos vía USING (evita inyección; tokens van con quote_literal).
  v_where := 's.store_id = $1'
    || ' and ($2 is null or s.supplier_company_id = $2)'
    || ' and ($3 is null or lower(public.imm_unaccent(v.city)) = $3)'
    || ' and ($4 = ''all'' or ($4 = ''active'' and s.is_active is true)'
    || ' or ($4 = ''inactive'' and s.is_active is not true))';

  -- Tokens AND entre sí, OR entre columnas. Cada token: substring exacto
  -- (rápido, usa GIN), similitud trigram (typos en campos cortos) o
  -- word_similarity token→columna (typos en nombres largos; la frase va
  -- segunda: word_similarity(trigramas del 1º, subconjunto del 2º)).
  if coalesce(btrim(p_q), '') <> '' then
    v_qnorm := lower(public.imm_unaccent(p_q));
    select coalesce(array_agg(t), '{}') into v_tokens
    from (select t from regexp_split_to_table(v_qnorm, '\s+') as t where t <> '' limit 6) s2;
    foreach v_t in array v_tokens loop
      v_esc := replace(replace(replace(v_t, '\', '\\'), '%', '\%'), '_', '\_');
      v_tconds := '{}';
      foreach v_col in array v_cols loop
        v_or := v_col || ' like ' || quote_literal('%' || v_esc || '%') || ' escape ''\''';
        if char_length(v_t) >= 3 then
          v_or := v_or || ' or ' || v_col || ' % ' || quote_literal(v_t);
        end if;
        if char_length(v_t) >= 4 then
          v_or := v_or || ' or word_similarity(' || quote_literal(v_t) || ', ' || v_col || ') > 0.45';
        end if;
        v_tconds := v_tconds || ('(' || v_or || ')');
      end loop;
      v_where := v_where || ' and (' || array_to_string(v_tconds, ' or ') || ')';
    end loop;
  end if;

  -- Ranking: mejor similitud entre columnas + bonus por prefijo en nombre.
  v_sim := '{}';
  foreach v_col in array v_cols loop
    v_sim := v_sim || ('coalesce(similarity(' || v_col || ', ' || quote_literal(coalesce(v_qnorm, '')) || '), 0)');
  end loop;

  -- Con búsqueda y sort default: relevancia primero. Sort explícito manda.
  if v_qnorm is not null and p_sort = 'name' and p_dir = 'asc' then
    v_order := 'score desc, ' || v_cols[1] || ' asc';
  elsif p_sort = 'name' then
    v_order := v_cols[1] || ' ' || p_dir;
  elsif p_sort = 'supplier' then
    v_order := 'lower(public.imm_unaccent(c.name)) ' || p_dir || ' nulls last, ' || v_cols[1] || ' asc';
  elsif p_sort = 'city' then
    v_order := 'lower(public.imm_unaccent(v.city)) ' || p_dir || ' nulls last, ' || v_cols[1] || ' asc';
  elsif p_sort = 'impact' then
    v_order := 's.impact_day ' || p_dir || ' nulls last, ' || v_cols[1] || ' asc';
  elsif p_sort = 'price' then
    v_order := 's.price_pen ' || p_dir || ' nulls last, ' || v_cols[1] || ' asc';
  else
    v_order := v_cols[1] || ' ' || p_dir;
  end if;

  v_sql := 'select s.id, s.name, s.is_active,'
    || ' s.width_px, s.height_px, s.width_m, s.height_m,'
    || ' s.price_pen, s.impact_day, s.impressions_day,'
    || ' v.district, v.city, v.name as venue_name,'
    || ' s.supplier_company_id, c.name as supplier_name, s.external_ref,'
    || ' (greatest(' || array_to_string(v_sim, ', ') || ')'
    || ' + case when ' || v_cols[1] || ' like ' || quote_literal(coalesce(v_qnorm, '') || '%')
    || ' then 0.15::real else 0::real end) as score,'
    || ' count(*) over () as total'
    || ' from inv_screens s'
    || ' left join inv_venues v on v.id = s.venue_id and v.store_id = s.store_id'
    || ' left join crm_companies c on c.id = s.supplier_company_id and c.store_id = $1'
    || ' where ' || v_where
    || ' order by ' || v_order
    || ' limit $5 offset $6';

  return query execute v_sql using p_store, p_supplier, v_citynorm, v_active, p_limit, p_offset;
  return;
end;
$func$;

-- Solo service_role (la app lee con service_role): mismo patrón que sys_run_start.
revoke all on function public.inv_search_screens(uuid, text, uuid, text, text, text, text, int, int)
  from public, anon, authenticated;
grant execute on function public.inv_search_screens(uuid, text, uuid, text, text, text, text, int, int)
  to service_role;
