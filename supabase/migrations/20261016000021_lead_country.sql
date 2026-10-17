-- País atribuido en leads para el filtro global (?market=).
-- Un lead es parecido a sus customers de referencia
-- (evidence_json.similar[].domain, verificados del pool): hereda la moda de
-- su país. Sin referencias (corridas viejas) queda null = comodín, se ve en
-- todo filtro (misma regla que customers/señales/acciones).
-- Solo se atribuye por evidencia verificada: nunca por TLD de la URL
-- (un .com mal etiquetado ocultaría el lead del mercado correcto).

alter table proposed_leads add column if not exists country text;

update proposed_leads l
set country = agg.top_country
from (
  select lead_id, country as top_country
  from (
    select l2.id as lead_id,
      c.country,
      row_number() over (partition by l2.id order by count(*) desc, c.country asc) as rn
    from proposed_leads l2
    join lateral (
      select s.value ->> 'domain' as domain
      from jsonb_array_elements(
        case when jsonb_typeof(coalesce(l2.evidence_json, '{}'::jsonb) -> 'similar') = 'array'
          then coalesce(l2.evidence_json, '{}'::jsonb) -> 'similar'
          else '[]'::jsonb
        end
      ) s
    ) refs on refs.domain is not null and refs.domain <> ''
    join customers c on c.store_id = l2.store_id
      and lower(split_part(c.email, '@', 2)) = lower(refs.domain)
      and c.country is not null
    where l2.country is null
    group by l2.id, c.country
  ) ranked
  where rn = 1
) agg
where l.id = agg.lead_id;

create index if not exists proposed_leads_store_country_idx on proposed_leads (store_id, country);
