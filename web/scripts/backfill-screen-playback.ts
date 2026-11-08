// Backfill de reproducciones/día en inv_screens desde el catálogo Perú (CSV).
// Uso:
//   npx tsx --env-file=.env.local scripts/backfill-screen-playback.ts [--csv RUTA] [--store ID] [--apply]
// Sin --apply es dry-run (solo reporta). Requiere la migración
// 20261205000000_screen_playback (columna inv_screens.plays_per_day).
// Fuente del dato: descripciones del CSV ("...se reproduce N veces al día...").
// Idempotente: solo actualiza filas cuyo plays_per_day sea null o distinto.
import { getSupabase } from "@/lib/supabase";
import { fail } from "./lib/run-once";
import { readFileSync } from "node:fs";

const DEFAULT_CSV = "/home/diegovelezg/Descargas/catalogo_peru_completo.csv";

/** Filas del CSV con dato físicamente imposible (verificado): se omiten del
 *  backfill para no restaurarlas. Corregir a mano en la ficha cuando el
 *  aliado confirme el valor real.
 *  - prod_01JRG9EJBP2ZKWSJWMBPSMSP29 (Benavides 1051): CSV dice 69.030/día
 *    con spot de 7s = 134 h/día. Imposible (tope 24h = 12.342). Typo fuente. */
const SKIP_EXT = new Set(["prod_01JRG9EJBP2ZKWSJWMBPSMSP29"]);

/** Parser CSV robusto (comillas + saltos de línea dentro de campos). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  const t = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"') {
        if (t[i + 1] === '"') { cur += '"'; i++; }
        else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && t[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

const WORD_NUM: Record<string, number> = {
  siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, quince: 15,
};

function toInt(raw: string): number | null {
  const s = raw.replace(/[.,]/g, "").trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Reproducciones/día desde la descripción (3 redacciones conocidas). */
function extractPlays(desc: string): number | null {
  const pats = [
    /se reproduce ([\d.,]+) veces al d/i,
    /reproduce tu anuncio ([\d.,]+) veces al d/i,
    /([\d.,]+) reproducciones? de tu anuncio al d/i,
  ];
  for (const p of pats) {
    const m = desc.match(p);
    if (m) {
      const n = toInt(m[1]);
      if (n) return n;
    }
  }
  return null;
}

/** Duración de pauta en segundos mencionada en la descripción (dígito o palabra). */
function extractPauta(desc: string): number | null {
  const m = desc.match(/pautas? de ([\w]+) segundos?/i);
  if (!m) return null;
  if (/^\d+$/.test(m[1])) return Number(m[1]);
  return WORD_NUM[m[1].toLowerCase()] ?? null;
}

async function main() {
  const args = process.argv.slice(2);
  const csvPath = args.includes("--csv") ? args[args.indexOf("--csv") + 1] : DEFAULT_CSV;
  const apply = args.includes("--apply");
  const storeArg = args.includes("--store") ? args[args.indexOf("--store") + 1] : null;
  if (!csvPath) throw new Error("Falta --csv RUTA.");

  const rows = parseCsv(readFileSync(csvPath, "utf8"));
  const header = rows[0];
  const extIdx = header.indexOf("external_id");
  const descIdx = header.indexOf("description");
  const durIdx = header.indexOf("duration_sec");
  if (extIdx < 0 || descIdx < 0 || durIdx < 0) throw new Error("CSV sin columnas external_id/description/duration_sec.");
  const data = rows.slice(1).filter((r) => (r[extIdx] ?? "").trim() !== "");
  console.log(`CSV: ${data.length} filas (${csvPath})`);

  const playsByExt = new Map<string, number>();
  const noPlays: string[] = [];
  const pautaMismatch: Array<{ ext: string; pauta: number; col: string }> = [];
  for (const r of data) {
    const ext = r[extIdx].trim();
    const plays = extractPlays(r[descIdx] ?? "");
    if (plays === null) noPlays.push(ext);
    else playsByExt.set(ext, plays);
    const pauta = extractPauta(r[descIdx] ?? "");
    const col = (r[durIdx] ?? "").trim();
    if (pauta !== null && col !== "" && pauta !== Number(col)) pautaMismatch.push({ ext, pauta, col });
  }
  console.log(`Reproducciones extraídas: ${playsByExt.size}/${data.length}`);
  if (noPlays.length > 0) console.log(`Sin dato en descripción (${noPlays.length}): ${noPlays.join(", ")}`);
  if (pautaMismatch.length > 0) {
    console.log(`Pauta≠columna (${pautaMismatch.length}, solo aviso, no se escribe):`);
    for (const m of pautaMismatch.slice(0, 20)) console.log(`  ${m.ext}: pauta ${m.pauta}s vs columna ${m.col}s`);
  }

  const db = getSupabase();
  let storeId = storeArg;
  if (!storeId) {
    const { data: s } = await db.from("sys_stores").select("id").order("created_at", { ascending: true }).limit(1).maybeSingle();
    if (!s) throw new Error("Sin tiendas en Supabase.");
    storeId = (s as { id: string }).id;
  }
  console.log(`Tienda: ${storeId}`);

  // ¿Existe la columna? (migración 20261205000000)
  const probe = await db.from("inv_screens").select("plays_per_day").eq("store_id", storeId).limit(1);
  if (probe.error && /plays_per_day|column/i.test(probe.error.message)) {
    throw new Error("Falta la columna inv_screens.plays_per_day: aplica la migración 20261205000000_screen_playback y reintenta.");
  }
  if (probe.error) throw new Error(`DB read: ${probe.error.message}`);

  const { data: screens, error } = await db
    .from("inv_screens")
    .select("id,external_ref,plays_per_day,duration_sec")
    .eq("store_id", storeId)
    .limit(2000);
  if (error) throw new Error(`DB read: ${error.message}`);
  const list = (screens ?? []) as Array<Record<string, unknown>>;
  const byExt = new Map(list.filter((s) => s.external_ref).map((s) => [String(s.external_ref), s]));
  console.log(`Pantallas en BD: ${list.length}`);

  const csvNotInDb = [...playsByExt.keys()].filter((e) => !byExt.has(e));
  const dbNotInCsv = list.filter((s) => s.external_ref && !playsByExt.has(String(s.external_ref)));
  if (csvNotInDb.length > 0) console.log(`CSV sin pantalla en BD (${csvNotInDb.length}): ${csvNotInDb.join(", ")}`);
  if (dbNotInCsv.length > 0) console.log(`BD sin fila en CSV (${dbNotInCsv.length}): ${dbNotInCsv.map((s) => String(s.external_ref)).join(", ")}`);

  const outliers: Array<{ ext: string; plays: number }> = [];
  const groups = new Map<number, string[]>();
  let alreadyOk = 0;
  for (const [ext, plays] of playsByExt) {
    const s = byExt.get(ext);
    if (!s) continue;
    if (SKIP_EXT.has(ext)) {
      console.log(`Omitida (dato fuente imposible, ver SKIP_EXT): ${ext} (CSV dice ${plays.toLocaleString("es")}/día)`);
      continue;
    }
    if (plays > 5000) outliers.push({ ext, plays });
    if (Number(s.plays_per_day) === plays) alreadyOk++;
    else {
      const g = groups.get(plays) ?? [];
      g.push(ext);
      groups.set(plays, g);
    }
  }
  const toUpdate = [...groups.values()].reduce((a, g) => a + g.length, 0);
  console.log(`Ya correctos: ${alreadyOk} | A actualizar: ${toUpdate} en ${groups.size} grupos`);
  if (outliers.length > 0) {
    console.log(`OUTLIERS (>5000/día, se aplican igual, revisar en ficha):`);
    for (const o of outliers) console.log(`  ${o.ext}: ${o.plays.toLocaleString("es")}/día`);
  }

  if (!apply) {
    console.log("DRY-RUN: nada escrito. Re-ejecuta con --apply para escribir.");
    return;
  }
  let ok = 0;
  const errs: string[] = [];
  for (const [plays, exts] of groups) {
    const { error: uerr } = await db
      .from("inv_screens")
      .update({ plays_per_day: plays, updated_at: new Date().toISOString() })
      .eq("store_id", storeId)
      .in("external_ref", exts);
    if (uerr) errs.push(`${plays}/día ×${exts.length}: ${uerr.message}`);
    else ok += exts.length;
  }
  console.log(`Escritos: ${ok} | Errores: ${errs.length}`);
  for (const e of errs) console.log(`  ERR ${e}`);
}

main().catch((e) => fail("BACKFILL-PLAYBACK", e));
