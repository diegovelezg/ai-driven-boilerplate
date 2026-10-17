-- Evidencia del agente al proponer (write-time): el modelo razona una vez y la
-- UI solo renderiza. Sin esto, el "por qué" se recalcula en cada render.
alter table proposed_leads
  add column evidence_json jsonb; -- {icp_manual, queries, similar:[{domain,label,industry,spent_minor,orders,why}], scored_at}
