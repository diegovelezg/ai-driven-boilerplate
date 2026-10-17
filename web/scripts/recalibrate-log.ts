// Lector del log auditable del vigilante (#6).
// Uso: npx tsx scripts/recalibrate-log.ts [--tail N] [--store ID] [--json]
// Solo node:fs: tsx-safe, sin cadena de imports del app.
// .data/recalibrate.jsonl es JSONL: una línea = un evento (ver lib/profile-recalibrate/log.ts).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LOG = join(process.cwd(), ".data", "recalibrate.jsonl");

interface LogEvent {
  ts: string;
  store_id: string;
  source: string;
  dry_run: boolean;
  outcome: string;
  reason: string;
  triggers: Array<{ kind: string; detail: string; requiresProfiler: boolean }>;
  proposal_id?: string;
  deltas?: Array<{ slot: string; de: string | null; a: string | null }>;
  duration_ms?: number;
}

function parse(line: string): LogEvent | null {
  try {
    const p = JSON.parse(line) as Record<string, unknown>;
    if (!p || typeof p.ts !== "string" || typeof p.outcome !== "string") return null;
    return p as unknown as LogEvent;
  } catch {
    return null;
  }
}

function main() {
  const args = process.argv.slice(2);
  const tailArg = args.indexOf("--tail");
  const storeArg = args.indexOf("--store");
  const tail = tailArg >= 0 ? Number(args[tailArg + 1] ?? 20) : 20;
  const store = storeArg >= 0 ? String(args[storeArg + 1] ?? "") : "";
  const asJson = args.includes("--json");

  if (!existsSync(LOG)) {
    console.log("Sin log todavía (.data/recalibrate.jsonl no existe): corre el vigilante una vez.");
    return;
  }
  const lines = readFileSync(LOG, "utf-8").split("\n").filter(Boolean);
  let bad = 0;
  let events = lines.flatMap((l) => {
    const e = parse(l);
    if (!e) {
      bad += 1;
      return [];
    }
    return [e];
  });
  if (store) events = events.filter((e) => e.store_id === store || e.store_id.startsWith(store));
  const shown = events.slice(-Math.max(1, tail));

  if (asJson) {
    console.log(JSON.stringify(shown, null, 1));
    return;
  }
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.outcome, (counts.get(e.outcome) ?? 0) + 1);
  console.log(
    `eventos=${events.length} corruptas=${bad} ` +
      [...counts.entries()].map(([k, v]) => `${k}=${v}`).join(" "),
  );
  for (const e of shown) {
    const trig = e.triggers.length > 0 ? ` triggers=[${e.triggers.map((t) => t.kind).join(",")}]` : "";
    const del = (e.deltas ?? []).map((d) => `${d.slot}:${d.de ?? "auto"}→${d.a ?? "auto"}`).join(" ");
    const ms = e.duration_ms !== undefined ? ` ${e.duration_ms}ms` : "";
    console.log(
      `${e.ts} [${e.source}${e.dry_run ? "+dry" : ""}] ${e.outcome}${ms} :: ${e.reason}${trig}${del ? ` :: ${del}` : ""}${e.proposal_id ? ` :: ${e.proposal_id.slice(0, 8)}` : ""}`,
    );
  }
}

main();
