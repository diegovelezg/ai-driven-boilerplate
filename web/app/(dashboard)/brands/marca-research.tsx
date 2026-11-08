"use client";

import { DomainResearchPanel } from "../companies/empresa-research";

/** Tab Perfil de marca: sin dominio propio, se descubre por búsqueda web. */
export function MarcaResearch({ brandName, canResearch }: { brandName: string; canResearch: boolean }) {
  return (
    <DomainResearchPanel
      researchBase={`/api/brands/${encodeURIComponent(brandName)}/research`}
      canResearch={canResearch}
    />
  );
}
