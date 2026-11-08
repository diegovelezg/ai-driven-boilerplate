-- Búsqueda fuzzy en CRM (empresas + contactos): pg_trgm + unaccent + ranking.
-- Mismo mecanismo que inv_search_screens: un roundtrip, tokens AND entre sí,
-- OR entre columnas, LIKE escapado + % trigram + word_similarity.
-- Deploy seguro: crm-db.ts usa cada RPC si existe y cae al filtro previo si no.

-- Indices trigram sobre los campos que ya busca el ilike actual.
create index if not exists crm_companies_name_trgm
  on crm_companies using gin (lower(public.imm_unaccent(name)) gin_trgm_ops);
create index if not exists crm_companies_tax_trgm
  on crm_companies using gin (lower(public.imm_unaccent(tax_id)) gin_trgm_ops);
create index if not exists crm_companies_domain_trgm
  on crm_companies using gin (lower(public.imm_unaccent(domain)) gin_trgm_ops);
create index if not exists crm_companies_email_trgm
  on crm_companies using gin (lower(public.imm_unaccent(email)) gin_trgm_ops);

create index if not exists crm_contacts_first_trgm
  on crm_contacts using gin (lower(public.imm_unaccent(first_name)) gin_trgm_ops);
create index if not exists crm_contacts_last_trgm
  on crm_contacts using gin (lower(public.imm_unaccent(last_name)) gin_trgm_ops);
create index if not exists crm_contacts_email_trgm
  on crm_contacts using gin (lower(public.imm_unaccent(email)) gin_trgm_ops);
create index if not exists crm_contacts_job_trgm
  on crm_contacts using gin (lower(public.imm_unaccent(job_title)) gin_trgm_ops);

-- Empresas: mismos filtros que listCrmCompanies (casa excluida: kind NOT NULL).
create or replace function public.crm_search_companies(
  p_store uuid,
  p_q text default null,
  p_kind text default null,
  p_sort text default 'name',
  p_dir text default 'asc',
  p_limit int default 50,
  p_offset int default 0
)
returns table (
  id uuid,
  store_id uuid,
  name text,
  kind text,
  tax_id text,
  domain text,
  email text,
  phone text,
  city text,
  country text,
  external_ref text,
  contacts_count bigint,
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
    'lower(public.imm_unaccent(c.name))',
    'lower(public.imm_unaccent(c.tax_id))',
    'lower(public.imm_unaccent(c.domain))',
    'lower(public.imm_unaccent(c.email))'
  ];
begin
  p_limit := greatest(1, least(coalesce(p_limit, 50), 200));
  p_offset := greatest(0, coalesce(p_offset, 0));
  if p_sort is null or p_sort not in ('name', 'type', 'contacts', 'tax_id') then
    p_sort := 'name';
  end if;
  if p_dir is null or p_dir not in ('asc', 'desc') then
    p_dir := case when p_sort = 'contacts' then 'desc' else 'asc' end;
  end if;

  -- La casa (kind IS NULL, red propia) nunca lista: no es contraparte.
  v_where := 'c.store_id = $1 and c.kind is not null'
    || ' and ($2 is null or c.kind = $2)';

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

  v_sim := '{}';
  foreach v_col in array v_cols loop
    v_sim := v_sim || ('coalesce(similarity(' || v_col || ', ' || quote_literal(coalesce(v_qnorm, '')) || '), 0)');
  end loop;

  if v_qnorm is not null and p_sort = 'name' and p_dir = 'asc' then
    v_order := 'score desc, ' || v_cols[1] || ' asc';
  elsif p_sort = 'name' then
    v_order := v_cols[1] || ' ' || p_dir;
  elsif p_sort = 'type' then
    v_order := 'c.kind ' || p_dir || ', ' || v_cols[1] || ' asc';
  elsif p_sort = 'tax_id' then
    v_order := 'lower(public.imm_unaccent(c.tax_id)) ' || p_dir || ' nulls last, ' || v_cols[1] || ' asc';
  elsif p_sort = 'contacts' then
    v_order := 'contacts_count ' || p_dir || ', ' || v_cols[1] || ' asc';
  else
    v_order := v_cols[1] || ' ' || p_dir;
  end if;

  v_sql := 'select c.id, c.store_id, c.name, c.kind, c.tax_id, c.domain, c.email,'
    || ' c.phone, c.city, c.country, c.external_ref,'
    || ' (select count(*) from crm_contacts cc where cc.store_id = $1 and cc.company_id = c.id) as contacts_count,'
    || ' (greatest(' || array_to_string(v_sim, ', ') || ')'
    || ' + case when ' || v_cols[1] || ' like ' || quote_literal(coalesce(v_qnorm, '') || '%')
    || ' then 0.15::real else 0::real end) as score,'
    || ' count(*) over () as total'
    || ' from crm_companies c'
    || ' where ' || v_where
    || ' order by ' || v_order
    || ' limit $3 offset $4';

  return query execute v_sql using p_store, p_kind, p_limit, p_offset;
  return;
end;
$func$;

-- Contactos: cruza persona + empresa (el `or` de PostgREST no llega al join).
create or replace function public.crm_search_contacts(
  p_store uuid,
  p_q text default null,
  p_company uuid default null,
  p_limit int default 100
)
returns table (
  id uuid,
  store_id uuid,
  company_id uuid,
  first_name text,
  last_name text,
  email text,
  phone text,
  job_title text,
  is_primary boolean,
  created_by text,
  updated_by text,
  company_name text,
  score real
)
language plpgsql
stable
security definer
set search_path = public
as $func$
declare
  v_qnorm text := null;
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
    'lower(public.imm_unaccent(cc.first_name))',
    'lower(public.imm_unaccent(cc.last_name))',
    'lower(public.imm_unaccent(cc.email))',
    'lower(public.imm_unaccent(cc.phone))',
    'lower(public.imm_unaccent(cc.job_title))',
    'lower(public.imm_unaccent(co.name))'
  ];
begin
  p_limit := greatest(1, least(coalesce(p_limit, 100), 200));

  v_where := 'cc.store_id = $1'
    || ' and ($2 is null or cc.company_id = $2)';

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

  v_sim := '{}';
  foreach v_col in array v_cols loop
    v_sim := v_sim || ('coalesce(similarity(' || v_col || ', ' || quote_literal(coalesce(v_qnorm, '')) || '), 0)');
  end loop;

  -- Con búsqueda: relevancia primero, luego antigüedad (paridad con el orden actual).
  if v_qnorm is not null then
    v_order := 'score desc, cc.created_at asc';
  else
    v_order := 'cc.created_at asc';
  end if;

  v_sql := 'select cc.id, cc.store_id, cc.company_id, cc.first_name, cc.last_name,'
    || ' cc.email, cc.phone, cc.job_title, cc.is_primary, cc.created_by, cc.updated_by, co.name as company_name,'
    || ' (greatest(' || array_to_string(v_sim, ', ') || ')'
    || ' + case when ' || v_cols[1] || ' like ' || quote_literal(coalesce(v_qnorm, '') || '%')
    || ' then 0.15::real else 0::real end) as score'
    || ' from crm_contacts cc'
    || ' left join crm_companies co on co.id = cc.company_id and co.store_id = $1'
    || ' where ' || v_where
    || ' order by ' || v_order
    || ' limit $3';

  return query execute v_sql using p_store, p_company, p_limit;
  return;
end;
$func$;

-- Solo service_role (la app lee con service_role).
revoke all on function public.crm_search_companies(uuid, text, text, text, text, int, int)
  from public, anon, authenticated;
grant execute on function public.crm_search_companies(uuid, text, text, text, text, int, int)
  to service_role;

revoke all on function public.crm_search_contacts(uuid, text, uuid, int)
  from public, anon, authenticated;
grant execute on function public.crm_search_contacts(uuid, text, uuid, int)
  to service_role;
