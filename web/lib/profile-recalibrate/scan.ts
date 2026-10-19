// Scan determinista del vigilante de perfil (#6). Sin LLM, sin BD: compara
// el snapshot anterior con las stats actuales y decide si hay drift.
// Basta 1 trigger "fuerte" para llamar al set perfilador; el de perfil
// viejo solo avisa. Silencio por defecto: sin trigger no pasa nada.
import { formatDecimal, formatNumber, formatPercentPoints } from "@/lib/format";

export interface StatsLike {
  customers: number;
  buyers: number;
  repeatRate: number;
  ticketMedian: number | null;
  ticketCurrency: string | null;
  intervalMedian: number | null;
  intervalCoverage: number;
  topDomains: Array<{ domain: string; customers: number }>;
  enrichedSample: Array<{ domain: string; industry: string | null }>;
}

export interface DriftTrigger {
  kind:
    | "buyers_ratio"
    | "repeat_delta"
    | "interval_drift"
    | "ticket_band"
    | "new_vertical"
    | "stale_profile"
    | "buyers_threshold"
    | "manual";
  detail: string;
  /** false = solo avisa (stale_profile): no justifica llamar al set caro. */
  requiresProfiler: boolean;
}

export interface ProfileLike {
  archetypeSource: "manual" | "sugerido" | "auto";
  /** Días desde que se fijó el perfil (interpreted/updated). */
  ageDays: number | null;
}

const BUYER_THRESHOLDS = [20, 50, 100] as const;

/** Triggers de drift entre el snapshot previo y las stats actuales. */
export function evaluateDrift(
  prev: StatsLike | null,
  curr: StatsLike,
  profile: ProfileLike,
  opts: { manual?: boolean } = {},
): DriftTrigger[] {
  const triggers: DriftTrigger[] = [];

  if (opts.manual) {
    triggers.push({
      kind: "manual",
      detail: "Revisión pedida a mano desde Settings.",
      requiresProfiler: true,
    });
  }

  if (prev) {
    // 1. La base de compradores se multiplicó.
    if (prev.buyers > 0 && curr.buyers / prev.buyers >= 2.0) {
      triggers.push({
        kind: "buyers_ratio",
        detail: `Compradores ${formatNumber(prev.buyers)} → ${formatNumber(curr.buyers)} (x${formatDecimal(curr.buyers / prev.buyers, 1)}).`,
        requiresProfiler: true,
      });
    }
    // 2. La recurrencia cambió de forma material.
    const repeatDelta = Math.abs(curr.repeatRate - prev.repeatRate);
    if (repeatDelta >= 0.15) {
      triggers.push({
        kind: "repeat_delta",
        detail: `Repeat ${formatPercentPoints(prev.repeatRate * 100)} → ${formatPercentPoints(curr.repeatRate * 100)} (Δ${formatPercentPoints(repeatDelta * 100)}pts).`,
        requiresProfiler: true,
      });
    }
    // 3. El intervalo real de recompra se movió ≥30% (con cobertura seria).
    if (
      prev.intervalMedian !== null &&
      curr.intervalMedian !== null &&
      prev.intervalMedian > 0 &&
      curr.intervalCoverage >= 0.2 &&
      Math.abs(curr.intervalMedian - prev.intervalMedian) / prev.intervalMedian >= 0.3
    ) {
      triggers.push({
        kind: "interval_drift",
        detail: `Intervalo mediano ${formatNumber(prev.intervalMedian)}d → ${formatNumber(curr.intervalMedian)}d (cobertura ${formatPercentPoints(curr.intervalCoverage * 100)}).`,
        requiresProfiler: true,
      });
    }
    // 4. El ticket cambió de tramo. Solo dentro de la misma moneda:
    //    comparar PEN con MXN inventaría drift (analyst agrupa por moneda).
    if (
      prev.ticketMedian !== null &&
      curr.ticketMedian !== null &&
      prev.ticketMedian > 0 &&
      prev.ticketCurrency !== null &&
      prev.ticketCurrency === curr.ticketCurrency &&
      (curr.ticketMedian <= prev.ticketMedian * 0.6 ||
        curr.ticketMedian >= prev.ticketMedian * 1.6)
    ) {
      triggers.push({
        kind: "ticket_band",
        detail: `Ticket mediano ${formatNumber(prev.ticketMedian)} → ${formatNumber(curr.ticketMedian)} ${curr.ticketCurrency}.`,
        requiresProfiler: true,
      });
    }
    // 5. El top-5 de dominios trae un vertical que antes no estaba.
    // Comparación simétrica: industrias del top-5 enriquecido de cada lado
    // (mismo universo). Asimetrías de muestreo (dominio antes sin enriquecer)
    // no disparan solas: el conjunto previo manda.
    const industriesOf = (s: StatsLike): Set<string> => {
      const top5 = new Set(s.topDomains.slice(0, 5).map((t) => t.domain));
      return new Set(
        s.enrichedSample
          .filter((e) => e.industry && top5.has(e.domain))
          .map((e) => e.industry as string),
      );
    };
    const prevIndustries = industriesOf(prev);
    // Sin cobertura previa en el top-5 no se distingue señal de muestreo
    // (dominio recién enriquecido): se difiere un ciclo, no se dispara.
    const added =
      prevIndustries.size > 0
        ? [...industriesOf(curr)].filter((i) => !prevIndustries.has(i))
        : [];
    const newVertical =
      added.length > 0
        ? curr.enrichedSample.find(
            (e) =>
              e.industry === added[0] &&
              curr.topDomains.slice(0, 5).some((t) => t.domain === e.domain),
          ) ?? null
        : null;
    if (newVertical?.industry) {
      triggers.push({
        kind: "new_vertical",
        detail: `Vertical nuevo en el top-5: ${newVertical.industry} (${newVertical.domain}).`,
        requiresProfiler: true,
      });
    }
  }

  // 7. Cruce de umbral de compradores (solo con perfil auto: el resto ya
  //    fue revisado por un humano o por el set al fijarse).
  const prevBuyers = prev?.buyers ?? 0;
  if (profile.archetypeSource === "auto") {
    for (const t of BUYER_THRESHOLDS) {
      if (prevBuyers < t && curr.buyers >= t) {
        triggers.push({
          kind: "buyers_threshold",
          detail: `Compradores cruzaron ${formatNumber(t)} (${formatNumber(prevBuyers)} → ${formatNumber(curr.buyers)}) con perfil auto.`,
          requiresProfiler: true,
        });
      }
    }
  }

  // 6. Perfil viejo: solo avisa, no gasta una corrida del set.
  if (profile.ageDays !== null && profile.ageDays > 90) {
    triggers.push({
      kind: "stale_profile",
      detail: `Perfil fijado hace ${formatNumber(Math.round(profile.ageDays))} días.`,
      requiresProfiler: false,
    });
  }

  return triggers;
}

export interface CadenceInput {
  /** taken_at del último snapshot (ISO) o null si nunca hubo uno. */
  lastSnapshotAt: string | null;
  hasPendingProposal: boolean;
  /** Compradores nuevos desde el snapshot anterior (o totales si no hay). */
  newBuyers: number;
  now: Date;
  /** La revisión manual salta cadencia y muestra mínima (trigger 8 basta). */
  manual?: boolean;
}

export interface CadenceVerdict {
  run: boolean;
  reason: string;
}

/** Cadencia semanal del scan barato: silencio si no toca. Tope 1 pendiente. */
export function checkCadence(input: CadenceInput): CadenceVerdict {
  if (input.hasPendingProposal) {
    return { run: false, reason: "Ya hay una propuesta de perfil esperando revisión." };
  }
  if (input.lastSnapshotAt && !input.manual) {
    const ageMs = input.now.getTime() - new Date(input.lastSnapshotAt).getTime();
    if (ageMs < 7 * 86_400_000) {
      return {
        run: false,
        reason: `Última revisión hace ${formatNumber(Math.max(0, Math.floor(ageMs / 86_400_000)))}d (<7d).`,
      };
    }
  }
  if (!input.manual && input.newBuyers < 10) {
    return {
      run: false,
      reason: `Muestra insuficiente: ${formatNumber(input.newBuyers)} compradores nuevos (<10).`,
    };
  }
  return { run: true, reason: "Toca revisión semanal." };
}

/** ¿La propuesta nace de datos aún escasos? Se marca provisional. */
export function isProvisional(triggers: DriftTrigger[], buyers: number): boolean {
  return (
    buyers < 50 &&
    triggers.some(
      (t) => t.kind === "buyers_threshold" || t.kind === "buyers_ratio",
    )
  );
}
