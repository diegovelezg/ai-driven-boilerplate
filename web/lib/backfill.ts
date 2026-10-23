// Backfill de onboarding: fotos a hoy-T + recupero al inbox.
// Se ejecuta UNA vez por tenant (needsBackfill: sin foto previa) desde el
// morning pipeline, tras el primer sync con historia. Re-correr es inocuo:
// las fotos son upsert idempotente y el recupero omite lo gestionado.
import { getSupabase } from "@/lib/supabase";
import { isRealDbOrder } from "@/lib/canonical";
import { runRetentionModel } from "@/lib/retention";

export const BACKFILL_CUTS_DAYS = [90, 60, 30];

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

type Row = Record<string, unknown>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readAll(db: any, table: string, select: string, apply: (q: any) => any): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await apply(
      db.from(table).select(select).range(from, from + 999),
    );
    if (error) throw new Error(`${table} read: ${error.message}`);
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < 1000) break;
    if (out.length >= 50000) throw new Error(`${table} truncado en 50k: acotar alcance`);
  }
  return out;
}

/** true si el tenant nunca tuvo foto (onboarding: primer sync con historia). */
export async function needsBackfill(storeId: string): Promise<boolean> {
  const db = getSupabase();
  const { data, error } = await db
    .from("customer_predictions")
    .select("id")
    .eq("store_id", storeId)
    .limit(1);
  if (error) throw new Error(`Backfill check: ${error.message}`);
  return (data ?? []).length === 0;
}

export async function runBackfillPhotos(
  storeId: string,
  cuts: number[] = BACKFILL_CUTS_DAYS,
): Promise<Array<{ cut: string; predicted: number; actuar: number; vigilar: number }>> {
  const out: Array<{ cut: string; predicted: number; actuar: number; vigilar: number }> = [];
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (const days of cuts) {
    const asOf = new Date(todayUTC.getTime() - days * 86_400_000);
    const res = await runRetentionModel(storeId, asOf);
    out.push({
      cut: asOf.toISOString().slice(0, 10),
      predicted: res.predicted,
      actuar: res.actuar,
      vigilar: res.vigilar,
    });
  }
  return out;
}

/** Recupera al inbox los flagged que nunca volvieron y no tienen nada
 *  vivo ni gestionado. Devuelve { recovered, skipped }. */
export async function recoverBacklog(
  storeId: string,
  cuts: number[] = BACKFILL_CUTS_DAYS,
): Promise<{ recovered: number; skipped: number }> {
  const db = getSupabase();
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  // Elegibilidad hoy (foto máxima, paginada; sin truncar en tiendas grandes).
  const latest = await readAll(db, "customer_predictions", "customer_id,decision,as_of", (q) =>
    q.eq("store_id", storeId).order("as_of", { ascending: false }).order("id", { ascending: false }),
  );
  const todayDecision = new Map<string, string>();
  for (const r of latest) {
    const cid = String(r.customer_id ?? "");
    if (cid && !todayDecision.has(cid)) todayDecision.set(cid, String(r.decision ?? ""));
  }

  let recovered = 0;
  let skipped = 0;
  for (const days of cuts) {
    const asOf = new Date(todayUTC.getTime() - days * 86_400_000);
    const cutIso = asOf.toISOString();
    const cutDay = cutIso.slice(0, 10);
    const preds = await readAll(db, "customer_predictions", "customer_id,p_recompra_h,evidence_json", (q) =>
      q
        .eq("store_id", storeId)
        .eq("as_of", cutIso)
        .in("decision", ["actuar", "revision_humana"])
        .order("id", { ascending: true }),
    );
    for (const p of preds) {
      const cid = String(p.customer_id ?? "");
      if (!cid) continue;
      const done = () => {
        skipped += 1;
      };
      const dec = todayDecision.get(cid) ?? "";
      if (dec === "sin_canal" || dec === "contactado_reciente") {
        done();
        continue;
      }
      // ¿Volvió solo después del corte? Solo cuentan órdenes reales.
      const back = await readAll(db, "orders", "id,status,payment_status,is_test", (q) =>
        q.eq("store_id", storeId).eq("customer_id", cid).gt("placed_at", cutIso).order("id", { ascending: true }),
      );
      if (
        back.some((o) =>
          isRealDbOrder({
            status: (o.status as string | null) ?? null,
            payment_status: (o.payment_status as string | null) ?? null,
            is_test: Boolean(o.is_test),
          }),
        )
      ) {
        done();
        continue;
      }
      // Señal viva o recuperada previa (cualquier estado: no resucitar lo
      // que el humano cerró ni duplicar lo gestionado). One-off: una
      // re-caída futura la atiende el pipeline normal, no un re-backfill.
      const sigs = await readAll(db, "churn_signals", "id,status,evidence_json", (q) =>
        q.eq("store_id", storeId).eq("customer_id", cid).order("id", { ascending: true }),
      );
      if (
        sigs.some((s) => {
          const st = String(s.status ?? "");
          const ev = (s.evidence_json as Record<string, unknown> | null) ?? null;
          const rec = typeof ev?.recovered_from === "string" && ev.recovered_from.length > 0;
          return st === "open" || st === "prioritized" || st === "actioned" || rec;
        })
      ) {
        done();
        continue;
      }
      // Borrador vivo (trabajo en curso) o rechazo reciente (el humano ya
      // dijo no hace poco): no resucitar. Un rejected/dispatched viejo no
      // veta: es otro contexto y la nota del recupero es información nueva.
      const drafts = await readAll(db, "proposed_actions", "id,status,created_at", (q) =>
        q.eq("store_id", storeId).eq("customer_id", cid).order("id", { ascending: true }),
      );
      const nowMs = Date.now();
      if (
        drafts.some((d) => {
          const st = String(d.status ?? "");
          if (st === "pending_review" || st === "approved" || st === "dispatched") return true;
          if (st !== "rejected") return false;
          const ms = Date.parse(String(d.created_at ?? ""));
          return Number.isFinite(ms) && nowMs - ms < 90 * 86_400_000;
        })
      ) {
        done();
        continue;
      }
      const ev = (p.evidence_json as Record<string, unknown> | null) ?? {};
      const t = ev.t_days != null ? Math.round(Number(ev.t_days)) : null;
      const ciclo = ev.cycle_days != null ? Math.round(Number(ev.cycle_days)) : null;
      const base =
        t !== null && ciclo !== null
          ? `sin comprar hace ${t}d (ciclo ~${ciclo}d)`
          : t !== null
            ? `sin comprar hace ${t}d`
            : "retention actuar";
      const mes = `${MESES[asOf.getUTCMonth()]}-${asOf.getUTCFullYear()}`;
      const reason = `${base} · Recuperado de ventana previa (debió volver en ${mes}).`;
      const score =
        p.p_recompra_h == null
          ? null
          : Math.round(Math.min(1, Math.max(0, Number(p.p_recompra_h))) * 100) / 100;
      const { error } = await db.from("churn_signals").insert({
        store_id: storeId,
        customer_id: cid,
        kind: "churn_risk",
        score,
        reason,
        status: "open",
        evidence_json: {
          generator: "backfill:v1",
          recovered_from: cutDay,
          run_at: new Date().toISOString(),
        },
      });
      if (error) throw new Error(`Recover insert: ${error.message}`);
      recovered += 1;
    }
  }
  return { recovered, skipped };
}
