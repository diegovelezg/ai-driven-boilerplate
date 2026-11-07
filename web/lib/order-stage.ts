// Etapa operativa de una orden: derivada de las hijas, no columna (evita desync).
// Carril operativo: Firmada → Autorizada (hito) → Materiales → Al aire →
// Por certificar → Cerrada. El cobro va en carril paralelo
// (lib/billing-status.ts): admite upfront y abonos a mitad de pauta.
// "Autorizada" es hito (se marca ✓ al registrar el OM); no es etapa filtrable.
export const ORDER_STEPS = [
  "Firmada",
  "Autorizada",
  "Materiales",
  "Al aire",
  "Por certificar",
] as const;

export type OrderStageKey =
  | "firmada"
  | "materiales"
  | "al_aire"
  | "por_certificar"
  | "cerrada"
  | "cancelada";

export const ORDER_STAGE_LABELS: Record<OrderStageKey, string> = {
  firmada: "Firmada",
  materiales: "Materiales",
  al_aire: "Al aire",
  por_certificar: "Por certificar",
  cerrada: "Cerrada",
  cancelada: "Cancelada",
};

export interface StageInput {
  status: string | null;
  signed: boolean;
  hasOm: boolean;
  materialsOk: boolean;
  ended: boolean;
  certified: boolean;
  /** Legacy: se ignora. El cobro vive en billing-status (carril paralelo). */
  paid?: boolean;
}

/** Índice para <Steps/> (0-4 paso activo, 5 = completo, -1 = cancelada). */
export function orderStage(input: StageInput): { index: number; stage: OrderStageKey } {
  if (input.status === "cancelled") return { index: -1, stage: "cancelada" };
  if (!input.signed || !input.hasOm) return { index: input.signed ? 1 : 0, stage: "firmada" };
  if (!input.materialsOk) return { index: 2, stage: "materiales" };
  if (!input.ended) return { index: 3, stage: "al_aire" };
  if (!input.certified) return { index: 4, stage: "por_certificar" };
  return { index: 5, stage: "cerrada" };
}

/** Prefijo por tenant: iniciales de las dos primeras palabras (espeja el
 *  backfill SQL). "Strong Minds Peru SAC" → "SM", "Acme" → "AC", vacío → "OI". */
export function prefixForStore(name: string | null | undefined): string {
  const clean = (s: string) => s.replace(/[^A-Za-z]/g, "").toUpperCase();
  const words = String(name ?? "").split(/\s+/).map(clean).filter(Boolean);
  const p = words.length > 1 ? (words[0][0] + words[1][0]) : (words[0] ?? "").slice(0, 2);
  return /^[A-Z]{2}$/.test(p) ? p : "OI";
}

/** Número legible: SM-2026-0005. */
export function buildIoNumber(prefix: string, year: number, seq: number): string {
  return `${prefix}-${year}-${String(seq).padStart(4, "0")}`;
}
