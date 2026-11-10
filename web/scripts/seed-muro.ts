// Seed del muro/inbox: genera el brief real sobre el set dummy limpio.
// Uso: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/seed-muro.ts
// Re-ejecutable: borra los demos legacy (audience_json.demo=true, que
// inventaban Alicorp/S/8.400/Óvalo Gutiérrez) y corre runBriefJob forzado.
// El inbox resultante deriva 100% del snapshot real (órdenes, líneas,
// OM, materiales, fotos, ocupación): sin cifras inventadas, sin hardcode.
// Requiere seed-ois-smartmedia.ts (+ facturas opcionales) primero.
import { getSupabase } from "@/lib/supabase";
import { fail, loadStoreId } from "./lib/run-once";

async function main(): Promise<void> {
  const db = getSupabase();
  const storeId = await loadStoreId();
  console.log(`[muro] store=${storeId}`);

  // Limpieza legacy: demos con cifras inventadas (versiones anteriores).
  const { data: prev } = await db.from("sys_insights").select("id,audience_json").eq("store_id", storeId);
  const demoIds = ((prev ?? []) as Array<Record<string, unknown>>)
    .filter((r) => (r.audience_json as Record<string, unknown> | null)?.demo === true)
    .map((r) => String(r.id));
  if (demoIds.length > 0) {
    await db.from("sys_insights").delete().in("id", demoIds);
    console.log(`[muro] demos legacy borrados: ${demoIds.length}`);
  }

  // El brief real: snapshot → hechos deterministas → narrador → sys_insights.
  const { runBriefJob } = await import("@/lib/insights");
  const r = await runBriefJob(storeId, { force: true, actor: "seed-muro" });
  console.log(`[muro] ${r.summary} (insertados: ${r.inserted})`);
  if (r.inserted === 0) {
    console.log("[muro] sin hechos nuevos: el snapshot no emite avisos o ya existen hoy (silencio por diseño).");
  }
}

main().catch((e) => fail("MURO", e));
