// Copywriter (Proponer, Fase A): por señal `prioritized` redacta
// WhatsApp/email con historial real → `proposed_actions` `pending_review`.
// Nunca envía: el humano aprueba en /review y el dispatcher ejecuta.
// LLM vía proceso `proposer_draft` (primario → fallback). Corre en
// background con `background_runs` kind `copywriter`.
import { getSupabase } from "@/lib/supabase";
import { advanceRun, finishRun, type RunStatus } from "@/lib/background";
import { createLogger } from "@/lib/log";
import { chatCompletionParams, getLlmConfig, reasoningBody, type ModelRef } from "@/lib/ai/llm-config";

const log = createLogger("copywriter");

const SYSTEM = `Redactas mensajes de recupero para un ecommerce (español, tono cercano, sin spam).
Responde SOLO con un objeto JSON válido, sin markdown, con este esquema exacto:
{"channel": "whatsapp"|"email", "subject": string|null, "body": string}
Reglas:
- Basa el mensaje en el historial real dado (producto, última compra, gasto). NO inventes productos ni cifras.
- whatsapp: máximo 400 caracteres, sin asunto (subject null). email: subject corto + body de máximo 1200 caracteres.
- Un solo mensaje, listo para enviar. Sin placeholders tipo [NOMBRE].
- Si hay teléfono, prefiere whatsapp; si no, email.`;

async function completeJson(
  ref: ModelRef,
  temp: number,
  maxTokens: number,
  effort: string | null,
  system: string,
  user: string,
): Promise<string> {
  const apiKey = ref.apiKeyEnv ? process.env[ref.apiKeyEnv] : undefined;
  if (!apiKey) throw new Error(`Falta ${ref.apiKeyEnv}`);
  const base = (ref.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const body: Record<string, unknown> = {
    model: ref.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    ...chatCompletionParams(ref.provider, ref.model, temp, maxTokens),
    response_format: { type: "json_object" },
    ...reasoningBody(ref.provider, ref.model, effort),
  };
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${ref.provider} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error(`${ref.provider}: respuesta vacía`);
  return content;
}

async function draft(system: string, user: string): Promise<string> {
  const cfg = getLlmConfig("proposer_draft");
  try {
    return await completeJson(cfg.primary, cfg.temperature, cfg.maxTokens, cfg.reasoningEffort, system, user);
  } catch (e) {
    if (!cfg.fallback) throw e;
    log(`primario ${cfg.primary.model} falló (${e instanceof Error ? e.message : e}); fallback a ${cfg.fallback.model}`);
    return await completeJson(cfg.fallback, cfg.temperature, cfg.maxTokens, cfg.reasoningEffort, system, user);
  }
}

export interface CopywriterOpts {
  /** Máx. borradores por corrida (control de coste LLM). */
  limit?: number;
}

interface Prioritized {
  id: string;
  kind: string;
  score: number | null;
  reason: string | null;
  customer_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
}

export async function runCopywriter(
  runId: string,
  storeId: string,
  opts: CopywriterOpts = {},
): Promise<void> {
  const { limit = 10 } = opts;
  const db = getSupabase();
  let drafted = 0;
  let failed = 0;
  const step = (current: string | null) =>
    advanceRun(runId, { processed: drafted, failed, current });
  try {
    const { data, error } = await db
      .from("churn_signals")
      .select("id,kind,score,reason,customer_id,customers(email,first_name,last_name,phone)")
      .eq("store_id", storeId)
      .eq("status", "prioritized")
      .order("score", { ascending: false, nullsFirst: false })
      .limit(Math.max(limit * 3, 30));
    if (error) throw new Error(`Signals read: ${error.message}`);
    const rows = ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
      const c = (r.customers ?? {}) as Record<string, unknown>;
      return {
        id: String(r.id),
        kind: String(r.kind ?? "churn_risk"),
        score: r.score == null ? null : Number(r.score),
        reason: (r.reason as string | null) ?? null,
        customer_id: String(r.customer_id),
        email: String(c.email ?? ""),
        first_name: (c.first_name as string | null) ?? null,
        last_name: (c.last_name as string | null) ?? null,
        phone: (c.phone as string | null) ?? null,
      } satisfies Prioritized;
    });
    log(`run ${runId} start priorizadas=${rows.length} limite=${limit}`);

    // Sin borrador pendiente/aprobado para la misma señal (no duplicar).
    const { data: existing } = await db
      .from("proposed_actions")
      .select("signal_id")
      .eq("store_id", storeId)
      .in("status", ["pending_review", "approved"])
      .not("signal_id", "is", null)
      .limit(500);
    const busy = new Set(
      ((existing ?? []) as Array<Record<string, unknown>>).map((a) => String(a.signal_id)),
    );
    const fresh = rows.filter((r) => !busy.has(r.id));
    const batch = fresh.slice(0, Math.max(0, limit));
    log(`run ${runId} candidatas=${batch.length} (con borrador: ${rows.length - fresh.length})`);

    for (const s of batch) {
      await step(s.email || s.customer_id);
      try {
        const { data: orders } = await db
          .from("orders")
          .select("total_amount,currency,placed_at,items_json,status,payment_status,is_test")
          .eq("customer_id", s.customer_id)
          .order("placed_at", { ascending: false })
          .limit(10);
        const hist = ((((orders ?? []) as Array<Record<string, unknown>>).filter((o) => {
          if (o.is_test === true) return false;
          const st = typeof o.status === "string" ? o.status.toLowerCase() : "";
          return !["cancelled", "canceled", "archived", "refunded"].includes(st);
        })).slice(0, 3).map((o) => {
          const items = ((o.items_json as Array<Record<string, unknown>>) ?? []).slice(0, 3)
            .map((i) => `${String(i.title ?? "—")} x${Number(i.quantity ?? 0)}`)
            .join("; ");
          return `- ${String(o.placed_at ?? "?").slice(0, 10)}: ${String(o.total_amount ?? "?")} ${String(o.currency ?? "")} (${items})`;
        })).join("\n") || "(sin compras visibles)";
        const name = [s.first_name, s.last_name].filter(Boolean).join(" ") || s.email;

        const raw = await draft(
          SYSTEM,
          `Cliente: ${name} <${s.email}>${s.phone ? ` tel ${s.phone}` : " (sin teléfono)"}\nObjetivo: ${s.kind} · score ${s.score ?? "?"} · motivo: ${s.reason ?? "—"}\nÚltimas compras:\n${hist}`,
        );
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const channel = parsed.channel === "email" ? "email" : "whatsapp";
        const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
        const subject = typeof parsed.subject === "string" && parsed.subject.trim() ? parsed.subject.trim().slice(0, 200) : null;
        if (!body) throw new Error("El LLM devolvió body vacío.");
        if (channel === "whatsapp" && body.length > 600) throw new Error("WhatsApp demasiado largo (>600).");
        if (body.length > 2000) throw new Error("Body demasiado largo (>2000).");

        const { error: insErr } = await db.from("proposed_actions").insert({
          store_id: storeId,
          customer_id: s.customer_id,
          signal_id: s.id,
          channel,
          subject: channel === "email" ? subject : null,
          body: body.slice(0, 2000),
          status: "pending_review",
        });
        if (insErr) throw new Error(`Action insert: ${insErr.message}`);
        const { error: sigErr } = await db
          .from("churn_signals")
          .update({ status: "actioned" })
          .eq("id", s.id);
        if (sigErr) throw new Error(`Signal update: ${sigErr.message}`);
        drafted += 1;
        log(`run ${runId} ${s.email} → ${channel} (${body.length} chars)`);
      } catch (e) {
        failed += 1;
        log(`run ${runId} ${s.email || s.customer_id} ERROR ${e instanceof Error ? e.message : e}`);
      }
    }

    await step(null);
    const status: RunStatus = drafted === 0 && failed > 0 ? "error" : "done";
    const summary = `${drafted} borradores · ${failed} fallidos`;
    await finishRun(runId, { status, processed: drafted, failed, summary });
    log(`run ${runId} ${status} ${summary}`);
  } catch (e) {
    await finishRun(runId, {
      status: "error",
      processed: drafted,
      failed,
      error: e instanceof Error ? e.message : String(e),
    });
    log(`run ${runId} ERROR ${e instanceof Error ? e.message : e}`);
  }
}
