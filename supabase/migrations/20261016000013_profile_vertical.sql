-- Verdad del agente por encima de listas cerradas (Fase 1c).
-- vertical_detected = palabras del agente (verdad primaria, nunca se coacciona).
-- taxonomy_id = nodo Shopify Standard Product Taxonomy (nullable; null = sin mapeo honesto).
-- buyer_type = granularidad del comprador que el perfilador deduce (nullable).
alter table store_profiles
  add column vertical_detected text,
  add column taxonomy_id text,
  add column buyer_type text;
