// Tope del inbox de prospección (Fase B). Importable desde cliente y
// servidor: solo constantes, sin dependencias.
export const PROSPECT_LEAD_CAP = 10;

/** Mensaje cuando el auto se pausa por tope (lenguaje humano, sin culpa). */
export const PROSPECT_PAUSED_HINT =
  "Pausamos al Prospector: tienes 10 por revisar. Cuando apruebes o descartes alguna, te propondrá nuevas empresas automáticamente.";

/** Mensaje cuando el Prospector no tiene base enriquecible (B2B-only). */
export const PROSPECT_B2B_ONLY_HINT =
  "El Prospector necesita base: al menos 3 dominios de empresas entre tus mejores compradores.";
