// Laboratorio de ranking (solo lectura). Compara 5 algoritmos sobre la mira real
// con checks automáticos de principios de negocio.
// Uso: npx tsx --env-file=.env.local scripts/smoke-ranking.ts
//
// A = actual: insignia → ticket x score x min(1,180/d)
// B = prior por segmento, SIN score: ticket x prior x min(1,180/d)
// D = modelo P completo: ticket x prior x exp(-d/120) x (1+lnF)/2
// C = ventana winback 7-365d F>=2: ticket x ln(1+F) x min(1,120/d)
// F = anclado a ciclo (60d): ticket x ln(1+F) x min(1,60/d)
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  absoluteRecencyScore,
  classifyPopulation,
  type SegmentKey,
} from "@/lib/insights";

const CYCLE = 60;
const soles = (minor: number) => Math.round(minor / 100);
const ticketOf = (total: number, orders: number) => (orders > 0 ? total / orders : 0);
const daysSince = (iso: string | null): number | null => {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.max(0, Math.floor(ms / 86_400_000));
};

const PRIORS: Record<SegmentKey, number> = {
  "En riesgo": 0.3,
  "Campeón": 0.25,
  "Recurrente": 0.2,
  "Ocasional": 0.12,
  "Nuevo": 0.1,
  "Inactivo": 0.04,
  "Sin compras": 0,
};

interface Cand {
  email: string;
  segment: SegmentKey;
  rAbs: number | null;
  days: number | null;
  f: number;
  ticket: number;
  score: number;
  badge: boolean;
  vals: Record<string, number | null>;
}

async function main() {
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const medusaUrl = String(
    JSON.parse(readFileSync(".data/connections.json", "utf-8")).medusaUrl,
  ).replace(/\/+$/, "");
  const { data: store } = await db.from("stores").select("id").eq("shop_url", medusaUrl).maybeSingle();
  if (!store) throw new Error("Sin store.");
  const storeId = store.id as string;

  const { data: sigRows } = await db
    .from("churn_signals")
    .select("customer_id,score,status")
    .eq("store_id", storeId)
    .in("status", ["open", "prioritized"])
    .limit(500);
  const ids = [...new Set(((sigRows ?? []) as any[]).map((r) => String(r.customer_id)))];
  const { data: popRows } = await db
    .from("customers")
    .select("id,email,orders_count,total_spent,last_order_at")
    .eq("store_id", storeId)
    .limit(5000);
  const pop = ((popRows ?? []) as any[]).map((r) => ({
    id: String(r.id),
    email: String(r.email ?? ""),
    f: Number(r.orders_count ?? 0),
    m: Number(r.total_spent ?? 0),
    last: (r.last_order_at as string | null) ?? null,
  }));
  const classified = classifyPopulation(
    pop.map((p) => ({ orders_count: p.f, total_spent: p.m, last_order_at: p.last })),
    Date.now(),
    CYCLE,
  );
  const byId = new Map(pop.map((p, i) => [p.id, { p, c: classified[i] }]));
  const scoreById = new Map(((sigRows ?? []) as any[]).map((r) => [String(r.customer_id), Number(r.score ?? 0)]));

  const cands: Cand[] = pop
    .filter((p) => ids.includes(p.id))
    .map((p) => {
      const { c } = byId.get(p.id)!;
      const d = daysSince(p.last);
      const ticket = soles(ticketOf(p.m, p.f));
      const score = scoreById.get(p.id) ?? 0;
      const dec180 = d === null ? 1 : Math.min(1, 180 / Math.max(1, d));
      const prior = PRIORS[c.segment] ?? 0;
      const freqW = (1 + Math.log1p(p.f)) / 2;
      const eligC = d !== null && d >= 7 && d <= 365 && p.f >= 2;
      return {
        email: p.email,
        segment: c.segment,
        rAbs: absoluteRecencyScore(d, CYCLE),
        days: d,
        f: p.f,
        ticket,
        score,
        badge: c.noLosPierdas,
        vals: {
          A: c.noLosPierdas ? 1e12 + ticket * score * dec180 : ticket * score * dec180,
          B: ticket * prior * dec180,
          D: ticket * prior * Math.exp(-(d ?? 9999) / 120) * freqW,
          C: eligC ? ticket * Math.log1p(p.f) * Math.min(1, 120 / Math.max(1, d!)) : null,
          F: ticket * Math.log1p(p.f) * Math.min(1, CYCLE / Math.max(1, d ?? 9999)),
        },
      };
    });

  const order = (key: string) =>
    cands
      .filter((r) => r.vals[key] !== null)
      .sort((x, y) => (y.vals[key] as number) - (x.vals[key] as number));

  const yu = (emailPart: string) => (list: Cand[]) => {
    const i = list.findIndex((r) => r.email.includes(emailPart));
    return i === -1 ? "fuera" : `#${i + 1}`;
  };

  for (const key of ["A", "B", "D", "C", "F"]) {
    const ranked = order(key);
    console.log(`\n== ${key} (elegibles ${ranked.length}/${cands.length}) ==`);
    ranked.slice(0, 7).forEach((r, i) =>
      console.log(
        `${i + 1}. ${r.email} [${r.segment} R${r.rAbs ?? "?"} ${r.days ?? "?"}d F=${r.f}${r.badge ? " NLP" : ""}] ticket=S/${r.ticket} v=${Math.round(r.vals[key] as number)}`,
      ),
    );
    const top3 = ranked.slice(0, 3);
    const top7 = ranked.slice(0, 7);
    console.log(
      `checks: yoshimyto=${yu("yoshimyto")(ranked)} nmelo=${yu("nmelo@")(ranked)} | ` +
        `top3 con >365d=${top3.filter((r) => (r.days ?? 0) > 365).length} | ` +
        `top1 absurdo (>730d)=${(ranked[0]?.days ?? 0) > 730 ? "SI " + ranked[0].email : "no"} | ` +
        `F>=4 en top7=${top7.filter((r) => r.f >= 4).length}`,
    );
  }
}

main().catch((e) => {
  console.error("SMOKE FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
