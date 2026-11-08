-- Estado del enriquecimiento geoespacial + IA por pantalla.
-- 'pending' = el job en segundo plano aún no termina (la ficha bloquea
-- ediciones para no pisar sus escrituras); 'done' = listo o se omitió
-- (best-effort: sin token, sin coords o fallo de red igual libera).
-- El inventario histórico nace en 'done': no hay nada pendiente.
alter table inv_screens
  add column if not exists enrichment_status text not null default 'done'
  check (enrichment_status in ('pending', 'done'));
