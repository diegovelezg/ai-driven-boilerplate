// Uso: npx tsx --env-file=.env.local scripts/sync-once.ts
// Sync manual ecommerce → Supabase usando la conexión guardada.
import { readFileSync } from "node:fs";
import { syncStoreFromMedusa } from "@/lib/sync";

const conn = JSON.parse(readFileSync(".data/connections.json", "utf-8"));
console.time("sync");
syncStoreFromMedusa(conn.medusaUrl, conn.medusaVersion || "v1", conn.medusaToken)
  .then((r) => {
    console.timeEnd("sync");
    console.log(JSON.stringify(r, null, 1));
  })
  .catch((e) => {
    console.error("SYNC FAIL:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
