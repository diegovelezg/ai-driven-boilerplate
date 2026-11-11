import { DAY_MS, isISODateShape, limaDayStart } from "@/lib/format";

// Etapa operativa de una orden: derivada de las hijas, no columna (evita desync).
// Carril operativo: Firmada → Autorizada (hito) → Materiales → Programada → Al aire →
// Por certificar → Cerrada. El cobro va en carril paralelo
// (lib/billing-status.ts): admite upfront y abonos a mitad de pauta.
// "Autorizada" es hito (se marca ✓ al registrar el OM); no es etapa filtrable.
export const ORDER_STEPS = [
  "Firmada",
  "Autorizada",
  "Materiales",
  "Programada",
  "Al aire",
  "Por certificar",
] as const;

export type OrderStageKey =
  | "firmada"
  | "materiales"
  | "programada"
  | "atrasada"
  | "al_aire"
  | "por_certificar"
  | "cerrada"
  | "cancelada";

export const ORDER_STAGES: OrderStageKey[] = [
  "firmada", "materiales", "programada", "atrasada", "al_aire", "por_certificar", "cerrada", "cancelada",
];

export const ORDER_STAGE_LABELS: Record<OrderStageKey, string> = {
  firmada: "Firmada",
  materiales: "Materiales",
  programada: "Programada",
  atrasada: "Salida atrasada",
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
  started: boolean;
  inFlight: boolean;
  ended: boolean;
  certified: boolean;
  /** Legacy: se ignora. El cobro vive en billing-status (carril paralelo). */
  paid?: boolean;
}

/** Fechas de cabecera inclusivas en Lima; líneas con fin exclusivo.
 * En huecos entre líneas no hay emisión prevista. */
export function orderTiming(
  order: { starts_at?: unknown; ends_at?: unknown },
  lines: Array<{ starts_at?: unknown; ends_at?: unknown }>,
  now: number,
): { started: boolean; inFlight: boolean; ended: boolean } {
  const periods = lines.length > 0 ? lines : [order];
  const ranges = periods.map((p) => {
    const start = typeof p.starts_at === "string"
      ? Date.parse(isISODateShape(p.starts_at) ? limaDayStart(p.starts_at) : p.starts_at) : NaN;
    const end = typeof p.ends_at === "string"
      ? Date.parse(isISODateShape(p.ends_at) ? limaDayStart(p.ends_at) : p.ends_at)
        + (isISODateShape(p.ends_at) ? DAY_MS : 0) : NaN;
    return { start, end };
  });
  return {
    started: ranges.some((p) => Number.isFinite(p.start) && p.start <= now),
    inFlight: ranges.some((p) => p.start <= now && now < p.end),
    ended: ranges.every((p) => Number.isFinite(p.end) && p.end <= now),
  };
}

/** Índice para <Steps/> (0-5 activo, 6 completo, -1 cancelada). */
export function orderStage(input: StageInput): { index: number; stage: OrderStageKey } {
  if (input.status === "cancelled") return { index: -1, stage: "cancelada" };
  if (!input.signed) return { index: 0, stage: "firmada" };
  if (input.started && (!input.hasOm || !input.materialsOk)) {
    return { index: input.hasOm ? 2 : 1, stage: "atrasada" };
  }
  if (!input.hasOm) return { index: 1, stage: "firmada" };
  if (!input.materialsOk) return { index: 2, stage: "materiales" };
  if (input.ended) return input.certified
    ? { index: 6, stage: "cerrada" }
    : { index: 5, stage: "por_certificar" };
  if (!input.inFlight) return { index: 3, stage: "programada" };
  return { index: 4, stage: "al_aire" };
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
