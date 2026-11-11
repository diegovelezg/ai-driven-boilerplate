-- Filtro por tipo de empresa en contactos: mismo multiselect que empresas
-- (?type / ?tipo, default agencia + anunciante en la app).
-- p_kinds null = todos; array vacío = ninguno (0 filas: el `co.id is null`
-- de sueltos queda dentro del `array_length > 0`, así que `none` no muestra
-- ni sueltos). Con filtro no vacío, los sueltos (company_id null) se
-- conservan: no tienen tipo y ocultarlos perdería datos.
-- DROP+CREATE (cambio de firma; llamadas dinámicas, sin dependientes).

drop function if exists public.crm_search_contacts(uuid, text, uuid, int, text);

create function public.crm_search_contacts(
  p_store uuid,
  p_q text default null,
  p_company uuid default null,
  p_limit int default 100,
  p_status text default 'active',
  p_kinds text[] default null
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
  deleted_at timestamptz,
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
  if p_status is null or p_status not in ('active', 'archived', 'all') then
    p_status := 'active';
  end if;

  v_where := 'cc.store_id = $1'
    || ' and ($2 is null or cc.company_id = $2)'
    || case p_status
      when 'archived' then ' and cc.deleted_at is not null'
      when 'all' then ''
      -- Activo = contacto activo de empresa activa (o sin empresa).
      else ' and cc.deleted_at is null and (co.id is null or co.deleted_at is null)'
    end
    -- p_kinds null = todos; vacío = ninguno; si no, la empresa del
    -- contacto debe matchear (sueltos se conservan).
    || ' and ($4 is null or (coalesce(array_length($4, 1), 0) > 0 and (co.id is null or co.kind = any($4))))';

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
    || ' cc.email, cc.phone, cc.job_title, cc.is_primary, cc.created_by, cc.updated_by, co.name as company_name, cc.deleted_at,'
    || ' (greatest(' || array_to_string(v_sim, ', ') || ')'
    || ' + case when ' || v_cols[1] || ' like ' || quote_literal(coalesce(v_qnorm, '') || '%')
    || ' then 0.15::real else 0::real end) as score'
    || ' from crm_contacts cc'
    || ' left join crm_companies co on co.id = cc.company_id and co.store_id = $1'
    || ' where ' || v_where
    || ' order by ' || v_order
    || ' limit $3';

  return query execute v_sql using p_store, p_company, p_limit, p_kinds;
  return;
end;
$func$;

-- Solo service_role (la app lee con service_role).
grant execute on function public.crm_search_contacts(uuid, text, uuid, int, text, text[])
  to service_role;
