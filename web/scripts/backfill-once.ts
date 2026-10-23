// Backfill de onboarding: fotos a hoy-T + recupero al inbox.
// Uso: npx tsx --env-file=.env.local scripts/backfill-once.ts [--cuts=90,60,30] [--recover=1]
// Solo escribe customer_predictions con as_of histórico y, con --recover,
// abre señales `open` para los flagged que nunca volvieron y no tienen nada
// vivo ni gestionado. El resto lo hace la cadena normal.
// En prod corre solo vía pipeline (lib/backfill, una vez por tenant).
import { BACKFILL_CUTS_DAYS, recoverBacklog, runBackfillPhotos } from "@/lib/backfill";
import { fail, loadStoreId } from "./lib/run-once";

function arg(name: string, def: string): string {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : def;
}

async function main() {
  const storeId = await loadStoreId();
  const cuts = arg("--cuts", BACKFILL_CUTS_DAYS.join(","))
    .split(",")
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const recover = arg("--recover", "1") !== "0";
  for (const r of await runBackfillPhotos(storeId, cuts)) {
    console.log(`foto ${r.cut}: predicted=${r.predicted} actuar=${r.actuar} vigilar=${r.vigilar}`);
  }
  if (!recover) return;
  const { recovered, skipped } = await recoverBacklog(storeId, cuts);
  console.log(`recuperados al inbox: ${recovered}, omitidos: ${skipped}`);
}

main().catch((e) => {
  fail("BACKFILL", e);
});
