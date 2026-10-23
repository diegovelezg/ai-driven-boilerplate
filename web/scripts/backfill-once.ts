// Backfill de onboarding: fotos a hoy-T + recupero al inbox.
// Uso: npx tsx --env-file=.env.local scripts/backfill-once.ts [--cuts=90,60,30] [--recover=1]
// Solo escribe customer_predictions con as_of histórico y, con --recover,
// abre señales `open` para los flagged que nunca volvieron y no tienen nada
// vivo ni gestionado (sin señal viva ni recuperada previa, sin borrador en
// ningún estado, con canal y sin contacto reciente hoy). El resto lo hace la
// cadena normal (strategist → copywriter).
// Idempotente: re-correr no duplica ni resucita lo que el humano cerró,
// rechazó o ya trabajó.
import { getSupabase } from "@/lib/supabase";
import { isRealDbOrder } from "@/lib/canonical";
import { runRetentionModel } from "@/lib/retention";
import { fail, loadStoreId } from "./lib/run-once";

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function arg(name: string, def: string): string {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : def;
}

type Row = Record<string, unknown>;

async function readAll(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  table: string,
  select: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apply: (q: any) => any,
): Promise<Row[]> {
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

async function main() {
  const storeId = await loadStoreId();
  const db = getSupabase();
  const cuts = arg("--cuts", "90,60,30")
    .split(",")
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const recover = arg("--recover", "1") !== "0";
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  for (const days of cuts) {
    const asOf = new Date(todayUTC.getTime() - days * 86_400_000);
    const res = await runRetentionModel(storeId, asOf);
    console.log(
      `foto -${days}d (${asOf.toISOString().slice(0, 10)}): predicted=${res.predicted} actuar=${res.actuar} vigilar=${res.vigilar}`,
    );
  }
  if (!recover) return;

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
      const done = (why: string) => {
        skipped += 1;
        console.log(`skip ${cutDay} ${cid.slice(0, 8)}: ${why}`);
      };
      const dec = todayDecision.get(cid) ?? "";
      if (dec === "sin_canal" || dec === "contactado_reciente") {
        done("inelegible hoy");
        continue;
      }
      // ¿Volvió solo después del corte? Solo cuentan órdenes reales.
      const back = await readAll(db, "orders", "id,status,payment_status,is_test", (q) =>
        q
          .eq("store_id", storeId)
          .eq("customer_id", cid)
          .gt("placed_at", cutIso)
          .order("id", { ascending: true }),
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
        done("volvió solo");
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
        done("señal previa");
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
        done("ya trabajado");
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
      console.log(`recuperado ${cutDay}: ${cid.slice(0, 8)} p=${score} (${base})`);
    }
  }
  console.log(`recuperados al inbox: ${recovered}, omitidos: ${skipped}`);
}

main().catch((e) => {
  fail("BACKFILL", e);
});
