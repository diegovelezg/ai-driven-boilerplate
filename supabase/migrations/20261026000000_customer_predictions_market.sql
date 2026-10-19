-- Motor por market (issue #21 Paso 3): etiqueta de partición en predicciones.
-- Una fila por (tienda, cliente, corte, versión) se mantiene: market_id es
-- etiqueta de qué partición la produjo (asignación única por cliente).
-- Sin FK para no bloquear backfill en markets aún no sincronizados.
alter table customer_predictions
  add column if not exists market_id uuid;

create index if not exists customer_predictions_store_market_asof_idx
  on customer_predictions (store_id, market_id, as_of desc);
