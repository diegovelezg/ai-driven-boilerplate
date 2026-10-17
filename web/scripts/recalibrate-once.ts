// Vigilante de perfil (#6) en corrida única, como profiler-once.ts.
// Uso: npx tsx --env-file=.env.local scripts/recalibrate-once.ts [--dry-run]
// Sin --dry-run: snapshot + (solo con drift) set perfilador + propuesta HITL
// en Settings. Nunca aplica cambios al perfil por sí solo.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { runRecalibration } from "@/lib/profile-recalibrate/service";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const medusaUrl = String(
    JSON.parse(readFileSync(".data/connections.json", "utf-8")).medusaUrl,
  ).replace(/\/+$/, "");
  const { data: store } = await db.from("stores").select("id").eq("shop_url", medusaUrl).maybeSingle();
  if (!store) throw new Error("Sin store para esta conexión.");
  const storeId = store.id as string;

  const outcome = await runRecalibration(storeId, { source: "script", dryRun });
  console.log(`recalibrate status=${outcome.status}: ${outcome.reason}`);
  for (const t of outcome.triggers) {
    console.log(`  trigger ${t.kind}${t.requiresProfiler ? "" : " (solo avisa)"}: ${t.detail}`);
  }
  for (const d of outcome.deltas ?? []) {
    console.log(`  delta ${d.slot}: ${d.de ?? "auto"} → ${d.a ?? "auto"} (${d.confianza}) ${d.evidencia}`);
  }
}

main().catch((e) => {
  console.error("RECALIBRATE FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
