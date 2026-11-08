-- Contexto humano por aviso (issue #11, feed v3): cliente, marca,
-- pantallas, monto y vigencia exactos desde OIs/líneas/empresas.
-- Solo ADD COLUMN nullable: nada que blindar según AGENTS.md.

alter table public.sys_insights
  add column if not exists context_json jsonb null;

comment on column public.sys_insights.context_json is
  'Contexto exacto del hecho (cliente, marca, pantallas, monto_minor, moneda, starts_at, ends_at). Lo escribe el analizador determinista; el narrador solo lo redacta.';
