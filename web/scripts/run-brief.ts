// Brief matutino del inbox (issue #11): corre runBriefJob por tienda.
// Headless con service-role (sin sesión): apto para cron.
// Uso: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/run-brief.ts [--store=<id>] [--force] [--actor=cron] [--limit=50] [--dry-run]
// Cron sugerido (6:00 Lima = 11:00 UTC): 0 11 * * * / npm run brief -- --actor=cron
// Exit 0 si al menos una tienda terminó ok (incluye "ya corrió"/"sin cambios");
// exit 1 si no hay tiendas o todas fallaron.
import { getSupabase } from "@/lib/supabase";
import { fail } from "./lib/run-once";

const args = process.argv.slice(2);
const opt = (name: string): string | null => {
  const p = `--${name}=`;
  const hit = args.find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length).trim() || null : null;
};
const has = (name: string): boolean => args.includes(`--${name}`);

async function listStoreIds(limit: number): Promise<string[]> {
  const db = getSupabase();
  const { data, error } = await db
    .from("sys_stores")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(Math.max(1, limit));
  if (error) throw new Error(`Stores read: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => String(r.id)).filter(Boolean);
}

async function main(): Promise<void> {
  const { runBriefJob, briefAlreadyRanToday, buildBriefFacts, dedupeKey, MAX_POSTS_PER_DAY } = await import("@/lib/insights");
  const only = opt("store");
  const force = has("force");
  const dry = has("dry-run");
  const actor = opt("actor") ?? "cron";
  const limit = Math.max(1, Number.parseInt(opt("limit") ?? "50", 10) || 50);
  const ids = only ? [only] : await listStoreIds(limit);
  if (ids.length === 0) throw new Error("Sin tiendas en Supabase.");
  console.log(`[brief] tiendas=${ids.length} force=${force ? 1 : 0} dry=${dry ? 1 : 0} actor=${actor}`);

  if (dry) {
    const { getDashboardSnapshot } = await import("@/lib/dashboard");
    const { startOfDayUTC } = await import("@/lib/format");
    const db = getSupabase();
    for (const storeId of ids) {
      const snap = await getDashboardSnapshot(storeId);
      const today00 = startOfDayUTC(Date.now());
      const { data: today } = await db
        .from("sys_insights")
        .select("id,kind,scope_id")
        .eq("store_id", storeId)
        .gte("created_at", new Date(today00).toISOString());
      const existing = new Set(((today ?? []) as Array<Record<string, unknown>>).map((r) => dedupeKey(String(r.kind ?? ""), (r.scope_id as string | null) ?? null)));
      const fresh = buildBriefFacts(snap, MAX_POSTS_PER_DAY)
        .filter((f) => !existing.has(dedupeKey(f.kind, f.scopeId)))
        .slice(0, Math.max(0, MAX_POSTS_PER_DAY - existing.size));
      console.log(`[brief:dry] store=${storeId} hechos=${fresh.length} ${fresh.map((f) => `${f.kind}:${f.scopeId ?? "global"}`).join(" ")}`);
    }
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const storeId of ids) {
    try {
      if (!force && (await briefAlreadyRanToday(storeId))) {
        console.log(`[brief] store=${storeId} skip: ya corrió hoy.`);
        ok += 1;
        continue;
      }
      const r = await runBriefJob(storeId, { force, actor });
      console.log(`[brief] store=${storeId} inserted=${r.inserted} ${r.summary}`);
      ok += 1;
    } catch (e) {
      failed += 1;
      console.error(`[brief] store=${storeId} ERROR:`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`[brief] fin: ok=${ok} failed=${failed}`);
  if (ok === 0) throw new Error("Ninguna tienda terminó ok.");
}

main().catch((e) => fail("BRIEF", e));
