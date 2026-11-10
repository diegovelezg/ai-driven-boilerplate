// Verticales raíz de taxonomía estándar (MIT, snapshot es).
// La taxonomía es la referencia; el vertical libre del agente es la verdad.
// El mapeo agente → taxonomy_id lo hace el propio agente con juicio (nullable).
import snapshot from "@/data/taxonomy-verticals.es.json";

interface TaxonomyVertical {
  taxonomy_id: string;
  prefix: string;
  name: string;
}

const VERTICALS: TaxonomyVertical[] = (
  snapshot as { verticals: TaxonomyVertical[] }
).verticals;

const VALID_IDS = new Set(VERTICALS.map((v) => v.taxonomy_id));

export function isKnownTaxonomyId(id: string | null): boolean {
  return !!id && VALID_IDS.has(id);
}

/** Nombre legible para un taxonomy_id (null si no es de la lista). */
export function verticalName(id: string | null): string | null {
  if (!id) return null;
  return VERTICALS.find((v) => v.taxonomy_id === id)?.name ?? null;
}

/** Fragmento del prompt: las 26 raíces entre las que el agente puede mapear (o null). */
export function taxonomyPromptFragment(): string {
  const lines = VERTICALS.map((v) => `- ${v.taxonomy_id} :: ${v.name}`).join("\n");
  return `Verticales (elige el taxonomy_id que mejor encaje con tu "vertical" o null si ninguno encaja — null honesto antes que forzado):\n${lines}`;
}
