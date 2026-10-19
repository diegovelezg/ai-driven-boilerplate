// Diff slot por slot entre el perfil vigente y lo que propone el set (#6).
// Solo entran los slots con drift real; los fijados a mano se respetan,
// el ciclo exige cobertura y la taxonomía debe ser un nodo conocido.
// Puro y determinista: el humano decide después, delta por delta.
import { isKnownTaxonomyId } from "@/lib/taxonomy";
import { ARCHETYPES, type ArchetypeId, type StoreProfile } from "@/lib/store-profiles";
import { formatNumber, formatPercentPoints } from "@/lib/format";

export type ProfileSlot =
  | "archetype"
  | "repurchase_cycle_days"
  | "taxonomy_id"
  | "buyer_type";

export interface ProfileDelta {
  slot: ProfileSlot;
  /** Valor vigente serializado (null = vacío/auto). */
  de: string | null;
  /** Valor propuesto serializado. */
  a: string | null;
  evidencia: string;
  confianza: "alta" | "media" | "baja";
  decision: "pending" | "accepted" | "rejected";
  decidedAt?: string | null;
}

/** Lo que el set perfilador propone (subconjunto de Synthesis). */
export interface ProposedSlots {
  archetype: ArchetypeId | null;
  cycleDays: number | null;
  taxonomyId: string | null;
  buyerType: string | null;
  evidence: Array<{
    slot: string;
    value: string;
    confidence: "alta" | "media" | "baja";
  }>;
}

const SLOT_EVIDENCE_KEYS: Record<ProfileSlot, string[]> = {
  archetype: ["archetype", "arquetipo"],
  repurchase_cycle_days: ["cycle_days", "cycle", "repurchase_cycle_days", "ciclo"],
  taxonomy_id: ["taxonomy_id", "taxonomy", "taxonomia"],
  buyer_type: ["buyer_type", "buyer", "comprador"],
};

function evidenceFor(
  slot: ProfileSlot,
  proposed: ProposedSlots,
  fallback: string,
): { evidencia: string; confianza: "alta" | "media" | "baja" } {
  const keys = SLOT_EVIDENCE_KEYS[slot];
  const hit = proposed.evidence.find((e) =>
    keys.some((k) => e.slot.toLowerCase().includes(k)),
  );
  return hit
    ? { evidencia: hit.value, confianza: hit.confidence }
    : { evidencia: fallback, confianza: "media" };
}

export interface DiffContext {
  /** Cobertura del intervalo medido (para la regla del ciclo). */
  intervalCoverage: number;
  /** Compradores actuales (evidencia del ciclo cuando no hay slot evidence). */
  intervalMedian: number | null;
  /** "slot:valor" rechazados en los últimos 60d: no se re-proponen. */
  rejectedKeys: Set<string>;
}

function deltaKey(slot: ProfileSlot, a: string | null): string {
  return `${slot}:${a ?? ""}`;
}

/**
 * Slots que el merchant fijó a mano: el vigilante nunca los toca.
 * Fuente única de verdad (la usan buildDeltas y applyDeltaToProfile).
 */
export function isManualSlot(profile: StoreProfile, slot: ProfileSlot): boolean {
  if ((profile.manualSlots ?? []).includes(slot)) return true;
  // Compat: perfiles guardados a mano antes de manual_slots protegen el arquetipo.
  if (profile.archetypeSource === "manual" && slot === "archetype") return true;
  return false;
}

/** Construye los deltas propuestos. Vacío = el set no corrigió nada. */
export function buildDeltas(
  profile: StoreProfile,
  proposed: ProposedSlots,
  ctx: DiffContext,
): ProfileDelta[] {
  const deltas: ProfileDelta[] = [];
  const push = (
    slot: ProfileSlot,
    de: string | null,
    a: string | null,
    fallbackEvidence: string,
  ) => {
    if (de === a) return;
    if (isManualSlot(profile, slot)) return;
    if (ctx.rejectedKeys.has(deltaKey(slot, a))) return;
    const { evidencia, confianza } = evidenceFor(slot, proposed, fallbackEvidence);
    deltas.push({ slot, de, a, evidencia, confianza, decision: "pending" });
  };

  if (proposed.archetype) {
    push(
      "archetype",
      profile.archetype,
      proposed.archetype,
      `Arquetipo propuesto por el set: ${proposed.archetype}.`,
    );
  }

  // Ciclo: solo con cobertura ≥20%. Sin cobertura, únicamente se propone
  // limpiarlo (null motivado por evidencia), nunca inventar un número.
  const cycleProposed =
    proposed.cycleDays !== null &&
    Number.isInteger(proposed.cycleDays) &&
    proposed.cycleDays >= 1 &&
    proposed.cycleDays <= 1095
      ? String(proposed.cycleDays)
      : null;
  if (cycleProposed !== null && ctx.intervalCoverage >= 0.2) {
    push(
      "repurchase_cycle_days",
      profile.repurchaseCycleDays !== null ? String(profile.repurchaseCycleDays) : null,
      cycleProposed,
      ctx.intervalMedian !== null
        ? `Intervalo mediano medido: ${formatNumber(ctx.intervalMedian)}d (cobertura ${formatPercentPoints(ctx.intervalCoverage * 100)}).`
        : "Ciclo propuesto por el set con datos de la tienda.",
    );
  } else if (cycleProposed === null && profile.repurchaseCycleDays !== null) {
    const { evidencia } = evidenceFor(
      "repurchase_cycle_days",
      proposed,
      "",
    );
    if (evidencia) {
      push(
        "repurchase_cycle_days",
        String(profile.repurchaseCycleDays),
        null,
        evidencia,
      );
    }
  }

  // Taxonomía: solo nodos Shopify conocidos. Proponer BORRAR la vigente
  // exige evidencia real del slot (igual que el ciclo): el synthesizer
  // convierte un nodo inválido del LLM en null, y eso no es evidencia.
  if (proposed.taxonomyId !== null && isKnownTaxonomyId(proposed.taxonomyId)) {
    push(
      "taxonomy_id",
      profile.taxonomyId,
      proposed.taxonomyId,
      `Nodo Shopify propuesto: ${proposed.taxonomyId}.`,
    );
  } else if (proposed.taxonomyId === null && profile.taxonomyId !== null) {
    const { evidencia } = evidenceFor("taxonomy_id", proposed, "");
    if (evidencia) {
      push("taxonomy_id", profile.taxonomyId, null, evidencia);
    }
  }

  if (proposed.buyerType) {
    push(
      "buyer_type",
      profile.buyerType,
      proposed.buyerType.slice(0, 80),
      `Comprador propuesto por el set: ${proposed.buyerType}.`,
    );
  }

  return deltas;
}

export type ApplyDeltaResult =
  | { ok: true; profile: StoreProfile }
  | { ok: false; message: string };

/**
 * Aplica UN delta aceptado al perfil (puro: no toca BD).
 * Valida de nuevo antes de escribir: arquetipo del catálogo, ciclo 1–1095,
 * taxonomía conocida; slot manual → rechazo (defensa en profundidad: buildDeltas
 * ya los excluye, pero una propuesta nunca debe poder pisarlos).
 */
export function applyDeltaToProfile(
  profile: StoreProfile,
  delta: ProfileDelta,
): ApplyDeltaResult {
  if (isManualSlot(profile, delta.slot)) {
    return { ok: false, message: "Ese slot fue fijado a mano: no se puede aplicar." };
  }
  const next: StoreProfile = { ...profile };
  switch (delta.slot) {
    case "archetype":
      if (!delta.a || !(delta.a in ARCHETYPES)) {
        return { ok: false, message: "Arquetipo propuesto inválido." };
      }
      next.archetype = delta.a as StoreProfile["archetype"];
      break;
    case "repurchase_cycle_days": {
      if (delta.a === null) {
        next.repurchaseCycleDays = null;
        break;
      }
      const n = Number(delta.a);
      if (!Number.isInteger(n) || n < 1 || n > 1095) {
        return { ok: false, message: "Ciclo propuesto inválido." };
      }
      next.repurchaseCycleDays = n;
      break;
    }
    case "taxonomy_id":
      if (delta.a !== null && !isKnownTaxonomyId(delta.a)) {
        return { ok: false, message: "Taxonomía propuesta inválida." };
      }
      next.taxonomyId = delta.a;
      break;
    case "buyer_type":
      next.buyerType = delta.a ? delta.a.slice(0, 80) : null;
      break;
  }
  return { ok: true, profile: next };
}

/**
 * Claves `slot:valor` rechazados hace <60d (puro). La ventana corre desde
 * la DECISIÓN (`decidedAt` del delta), no desde la creación de la
 * propuesta: una propuesta vieja rechazada ayer sigue bloqueando.
 * Sin `decidedAt` (legado) se cae a la fecha de la propuesta.
 */
export function collectRejectedKeys(
  rows: Array<{ createdAt: string; deltas: ProfileDelta[] }>,
  now: Date,
): Set<string> {
  const keys = new Set<string>();
  const WINDOW_MS = 60 * 86_400_000;
  for (const row of rows) {
    for (const d of row.deltas) {
      if (d.decision !== "rejected") continue;
      const ref = d.decidedAt ?? row.createdAt;
      const t = new Date(ref).getTime();
      if (!Number.isNaN(t) && now.getTime() - t < WINDOW_MS) {
        keys.add(deltaKey(d.slot, d.a));
      }
    }
  }
  return keys;
}

/**
 * Deshace SOLO mi decisión sobre deltas frescos (puro): el slot vuelve a
 * `pending` sin tocar lo que otros hayan decidido después. null = el slot
 * no estaba decidido (nada que deshacer) o no existe.
 */
export function mergeDeltaRevert(
  fresh: ProfileDelta[],
  slot: ProfileSlot,
): ProfileDelta[] | null {
  let touched = false;
  const merged = fresh.map((d) => {
    if (d.slot === slot && d.decision !== "pending") {
      touched = true;
      return { ...d, decision: "pending" as const, decidedAt: null };
    }
    return d;
  });
  return touched ? merged : null;
}

export type ProposalStatus = "approved" | "rejected" | "pending_review";

/** Estado de la propuesta según sus deltas: solo cierra cuando no quedan pending. */
export function resolveProposalStatus(deltas: ProfileDelta[]): ProposalStatus {
  if (deltas.some((d) => d.decision === "pending")) return "pending_review";
  return deltas.some((d) => d.decision === "accepted") ? "approved" : "rejected";
}

export type DeltaDecision = "accepted" | "rejected";

/**
 * Fusiona mi decisión sobre deltas frescos (puro): marca el slot solo si sigue
 * pending. null = otro ya lo decidió (el llamador re-lee o informa, nunca pisa).
 */
export function mergeDeltaDecision(
  fresh: ProfileDelta[],
  slot: ProfileSlot,
  decision: DeltaDecision,
  nowIso: string,
): ProfileDelta[] | null {
  let touched = false;
  const merged = fresh.map((d) => {
    if (d.slot === slot && d.decision === "pending") {
      touched = true;
      return { ...d, decision, decidedAt: nowIso };
    }
    return d;
  });
  return touched ? merged : null;
}
