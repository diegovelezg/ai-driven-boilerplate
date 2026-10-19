// Refresco total al motor nuevo (issue #9): cierra las señales open/prioritized
// del motor antiguo (formato "media Nd", sin sello) y recorre retention →
// scout → strategist → copywriter para dejar la cola 100% retention:v1.
// Uso: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/refresh-retention-v1.ts [copyLimit]
// Nunca toca: señales retention:v1, señales con borrador vivo
// (pending_review/approved) ni borradores approved/dispatched.
import { getSupabase } from "@/lib/supabase";
import { runRetentionModel } from "@/lib/retention";
import { runScout } from "@/lib/scout";
import { runStrategist } from "@/lib/strategist";
import { runCopywriter } from "@/lib/copywriter";
import { startRun } from "@/lib/background";
import { fail, loadStoreId } from "./lib/run-once";

/** Formato viejo del scout pre-retention ("media Nd"); el nuevo es "ciclo ~Nd". */
function isLegacyReason(reason: string | null): boolean {
  if (!reason) return true;
  return /media \d+d/i.test(reason) && !/ciclo ~\d+d/i.test(reason);
}

async function main() {
  const storeId = await loadStoreId();
  const db = getSupabase();
  const copyLimit = Number(process.argv[2] ?? 10);

  const { data: sigs, error: sigErr } = await db
    .from("churn_signals")
    .select("id,customer_id,reason,status,evidence_json")
    .eq("store_id", storeId)
    .in("status", ["open", "prioritized"])
    .limit(1000);
  if (sigErr) throw new Error(`Signals read: ${sigErr.message}`);
  const all = ((sigs ?? []) as Array<Record<string, unknown>>);
  const legacy = all.filter((s) => isLegacyReason((s.reason as string | null) ?? null));
  console.log(`abiertas+priorizadas=${all.length} legacy=${legacy.length} retention_v1=${all.length - legacy.length}`);

  // Borradores vivos: esas señales no se tocan (sus pendientes se regeneran
  // con regenerateStaleDraftsAction, nunca se huérfanan).
  const { data: live } = await db
    .from("proposed_actions")
    .select("signal_id")
    .eq("store_id", storeId)
    .in("status", ["pending_review", "approved"])
    .not("signal_id", "is", null)
    .limit(1000);
  const busy = new Set(
    ((live ?? []) as Array<Record<string, unknown>>).map((a) => String(a.signal_id)),
  );
  const closable = legacy.filter((s) => !busy.has(String(s.id)));
  const blocked = legacy.filter((s) => busy.has(String(s.id)));
  console.log(`legacy con borrador vivo (intactas)=${blocked.length}`);
  for (const s of blocked) {
    console.log(`  viva ${String(s.id).slice(0, 8)} customer=${String(s.customer_id).slice(0, 8)} reason=${String(s.reason).slice(0, 80)}`);
  }

  let closed = 0;
  for (const s of closable) {
    const prev = ((s.evidence_json as Record<string, unknown> | null) ?? {});
    const { error } = await db
      .from("churn_signals")
      .update({
        status: "closed",
        closed_at: new Date().toISOString(),
        evidence_json: { ...prev, purged: "refresh-retention-v1", at: new Date().toISOString() },
      })
      .eq("id", String(s.id));
    if (error) throw new Error(`Signal close ${s.id}: ${error.message}`);
    closed += 1;
  }
  console.log(`legacy cerradas=${closed}`);

  const retention = await runRetentionModel(storeId);
  console.log(`retention predicted=${retention.predicted} actuar=${retention.actuar} vigilar=${retention.vigilar}`);
  const scoutRun = await startRun(storeId, "scout", "Scout", 0);
  await runScout(scoutRun, storeId);
  console.log(`scout fin (run ${scoutRun})`);
  const stratRun = await startRun(storeId, "strategist", "Estratega", 0);
  await runStrategist(stratRun, storeId);
  console.log(`strategist fin (run ${stratRun})`);
  const copyRun = await startRun(storeId, "copywriter", "Copywriter", 0);
  await runCopywriter(copyRun, storeId, { limit: copyLimit });
  console.log(`copywriter fin (run ${copyRun}, ver .data/copywriter.log)`);
}

main().catch((e) => {
  fail("REFRESH", e);
});
