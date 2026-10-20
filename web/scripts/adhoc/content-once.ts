// Backfill Nivel 1: contenido de visión (deepseek-chat) para archivos de órdenes REALES.
// AD-HOC (un solo uso contra prod para rescatar data, no parte del pipeline).
// Uso: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/adhoc/content-once.ts
// Universo: órdenes reales (no test/canceladas/pago fallido) + URL viva (HEAD) + dedup por sha256(url).
// Resume-safe: salta hashes ya presentes en item_content. Guarda crudo (content_json) + vivas/muertas.
// NUNCA toca el comentario humano del metadata (fuente de Medusa).
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { getSupabase } from "@/lib/supabase";
import { mapPool } from "@/lib/parallel";

const execFileAsync = promisify(execFile);
const CONCURRENCY = 4;
const VIDEO_EXT = new Set(["mp4", "mov", "avi", "webm", "mkv", "m4v"]);
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp"]);
const EXCLUDED_ORDER_STATUSES = new Set(["canceled", "cancelled", "archived", "requires_action"]);
const EXCLUDED_PAYMENT_STATUSES = new Set(["canceled", "cancelled", "failed"]);

/** Respaldo plano antes de cada upsert: si la DB se pierde, el dato sobrevive aquí. */
const BACKUP_PATH = ".data/content-backup.jsonl";

async function backupRow(row: Record<string, unknown>): Promise<void> {
  await appendFile(BACKUP_PATH, JSON.stringify(row) + "\n");
}

/** Extractor del tipo de negocio DOOH (pantallas): cada tipo registra el suyo. */
const DOOH_PROMPT =
  "Pieza publicitaria de pantalla exterior en Perú. Responde SOLO JSON: " +
  '{"marca": string|null, "que_anuncia": string, "categoria": string, "texto_visible": string, "confianza": "alta"|"media"|"baja"}. ' +
  "Si son 3 frames del mismo video, intégralos. NO inventes.";

function sha(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

function kindOf(url: string): "video" | "image" | null {
  const ext = decodeURIComponent(url).split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  if (VIDEO_EXT.has(ext)) return "video";
  if (IMAGE_EXT.has(ext)) return "image";
  return null;
}

async function urlAlive(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function visionCaption(imagePaths: string[]): Promise<Record<string, unknown>> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("Falta DEEPSEEK_API_KEY");
  const { readFile } = await import("node:fs/promises");
  const content: unknown[] = [{ type: "text", text: DOOH_PROMPT }];
  for (const p of imagePaths) {
    const b64 = (await readFile(p)).toString("base64");
    content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } });
  }
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content }],
      response_format: { type: "json_object" },
      max_tokens: 400,
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("DeepSeek: respuesta vacía");
  // json_object a veces trae comillas sin escapar: 1 reintento antes de rendirse.
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    console.log(`JSON roto, reintentando: ${text.slice(0, 120)}…`);
    const res2 = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "user", content },
          { role: "assistant", content: text },
          { role: "user", content: "Eso no era JSON válido. Repítelo como JSON válido, sin cambiar el contenido." },
        ],
        response_format: { type: "json_object" },
        max_tokens: 400,
      }),
    });
    if (!res2.ok) throw new Error(`DeepSeek retry ${res2.status}`);
    const data2 = await res2.json();
    const text2 = data2?.choices?.[0]?.message?.content;
    if (typeof text2 !== "string" || !text2.trim()) throw new Error("DeepSeek retry: vacía");
    return JSON.parse(text2) as Record<string, unknown>;
  }
}

async function framesFor(url: string, kind: "video" | "image", dir: string): Promise<string[]> {
  const src = join(dir, `src.${kind === "video" ? "mp4" : "img"}`);
  const dl = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!dl.ok || !dl.body) throw new Error(`Descarga ${dl.status}`);
  const buf = Buffer.from(await dl.arrayBuffer());
  if (buf.length < 1_000) throw new Error("Descarga vacía (probable XML de S3)");
  if (buf.slice(0, 5).toString().startsWith("<?xml")) throw new Error("S3 NoSuchKey");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(src, buf);
  if (kind === "image") {
    const out = join(dir, "frame.jpg");
    await execFileAsync("ffmpeg", ["-y", "-v", "error", "-i", src, "-vf", "scale=1024:-1", out]);
    return [out];
  }
  const probe = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", src,
  ]);
  const dur = Math.max(4, Number(probe.stdout.trim()) || 7);
  const outs: string[] = [];
  for (const [i, t] of [dur * 0.2, dur * 0.5, dur * 0.8].entries()) {
    const out = join(dir, `frame${i}.jpg`);
    await execFileAsync("ffmpeg", ["-y", "-v", "error", "-ss", String(t.toFixed(1)), "-i", src, "-frames:v", "1", out]);
    outs.push(out);
  }
  return outs;
}

async function main() {
  const conn = JSON.parse(readFileSync(".data/connections.json", "utf-8"));
  const shopUrl = String(conn.medusaUrl).trim().replace(/\/+$/, "").toLowerCase();
  const db = getSupabase();
  const { data: store } = await db.from("stores").select("id").eq("platform", "medusa").eq("shop_url", shopUrl).maybeSingle();
  if (!store) throw new Error("Tienda sin sincronizar en Supabase.");
  const storeId = store.id as string;

  // Key de archivo desde el mapa del tenant (settings → metadata_map).
  const { resolveItemKeys } = await import("@/lib/metadata-map");
  const keys = await resolveItemKeys(storeId);
  if (!keys.file) throw new Error("Sin key de contenido: define el mapa en settings (metadata_map).");
  console.log(`Key de contenido: ${keys.file}`);

  const { data: orders, error } = await db.from("orders").select("status,payment_status,is_test,items_json").eq("store_id", storeId);
  if (error) throw error;
  const seen = new Map<string, "video" | "image">();
  for (const o of orders ?? []) {
    const real =
      !o.is_test &&
      !(o.status && EXCLUDED_ORDER_STATUSES.has(String(o.status).toLowerCase())) &&
      !(o.payment_status && EXCLUDED_PAYMENT_STATUSES.has(String(o.payment_status).toLowerCase()));
    if (!real) continue;
    for (const it of ((o.items_json as Array<Record<string, unknown>>) ?? [])) {
      const md = (it.metadata as Record<string, unknown> | null) ?? null;
      const url = md && typeof md[keys.file] === "string" ? String(md[keys.file]) : null;
      if (!url || seen.has(url)) continue;
      const kind = kindOf(url);
      if (kind) seen.set(url, kind);
    }
  }
  console.log(`URLs únicas (reales): ${seen.size}`);

  const { data: existing } = await db.from("item_content").select("content_hash").eq("store_id", storeId);
  const done = new Set((existing ?? []).map((r) => r.content_hash as string));
  const pending = [...seen.entries()].filter(([url]) => !done.has(sha(url)));
  console.log(`Ya captionadas: ${done.size}. Pendientes: ${pending.length}`);
  if (pending.length === 0) return;

  let ok = 0, dead = 0, fail = 0;
  await mapPool(pending, CONCURRENCY, async ([url, kind]) => {
    const dir = await mkdtemp(join(tmpdir(), "cap-"));
    try {
      if (!(await urlAlive(url))) {
        const row = {
          content_hash: sha(url), store_id: storeId, content_url: url,
          content_kind: kind, content_json: null, model: null, alive: false,
        };
        await backupRow(row);
        await db.from("item_content").upsert(row, { onConflict: "store_id,content_hash" });
        dead++;
        return;
      }
      const frames = await framesFor(url, kind, dir);
      const caption = await visionCaption(frames);
      const row = {
        content_hash: sha(url), store_id: storeId, content_url: url,
        content_kind: kind, content_json: caption, model: "deepseek-chat", alive: true,
      };
      await backupRow(row);
      const { error: upErr } = await db.from("item_content").upsert(row, { onConflict: "store_id,content_hash" });
      if (upErr) throw upErr;
      ok++;
    } catch (e) {
      fail++;
      const detail = e instanceof Error ? e.message : JSON.stringify(e)?.slice(0, 300);
      console.log(`FAIL ${url.slice(0, 90)}…: ${detail}`);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      if ((ok + dead + fail) % 25 === 0) console.log(`progreso ok=${ok} muertas=${dead} fallos=${fail}`);
    }
  });
  console.log(`FIN ok=${ok} muertas=${dead} fallos=${fail}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
