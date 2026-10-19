// Helper LLM del set perfilador: un proceso de llm_models.json, JSON nativo,
// primario → fallback. Sin texto libre (los agentes devuelven veredictos).
import { chatCompletionParams, getLlmConfig, reasoningBody, type ModelRef } from "@/lib/ai/llm-config";
import { logLlmUsage, parseChatUsage } from "@/lib/ai/usage";
import { createProfilerLogger } from "./log";

const log = createProfilerLogger();

// Sin timeout, un provider colgado deja el pipeline esperando para siempre:
// el fallback solo salta ante error, nunca ante un fetch que no responde.
// El log muestra etapas normales de 10-30s; 120s es techo generoso.
const LLM_TIMEOUT_MS = 120_000;

export interface ProcessJsonOpts {
  storeId?: string | null;
  usedFallback?: boolean;
}

async function once(
  ref: ModelRef,
  proc: string,
  system: string,
  user: string,
  opts: ProcessJsonOpts = {},
): Promise<string> {
  const cfg = getLlmConfig(proc);
  const apiKey = ref.apiKeyEnv ? process.env[ref.apiKeyEnv] : undefined;
  if (!apiKey) throw new Error(`Falta ${ref.apiKeyEnv}`);
  const base = (ref.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  // deepseek con thinking activado se come el presupuesto en reasoning y
  // trunca el JSON (empírico x2): el fallback va sin thinking, tonto pero vivo.
  const effort = ref.provider === "deepseek" ? null : cfg.reasoningEffort;
  const t0 = Date.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    body: JSON.stringify({
      model: ref.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...chatCompletionParams(ref.provider, ref.model, cfg.temperature, cfg.maxTokens),
      response_format: { type: "json_object" },
      ...reasoningBody(ref.provider, ref.model, effort),
    }),
  });
  if (!res.ok) throw new Error(`${ref.provider} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const choice = data?.choices?.[0] ?? {};
  const c = choice?.message?.content;
  const usage = parseChatUsage(data);
  if (opts.storeId && usage) {
    void logLlmUsage({
      storeId: opts.storeId,
      process: proc,
      provider: ref.provider,
      model: ref.model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      reasoningTokens: usage.reasoningTokens,
      latencyMs: Date.now() - t0,
      usedFallback: opts.usedFallback ?? false,
    });
  }
  if (typeof c !== "string" || !c.trim()) {
    log(`${proc} respuesta vacía: finish=${choice?.finish_reason ?? "?"} keys=${Object.keys(choice?.message ?? {}).join(",")} refusal=${JSON.stringify(choice?.message?.refusal ?? null).slice(0, 120)} usage=${JSON.stringify(data?.usage?.completion_tokens_details ?? null)}`);
    throw new Error(`${ref.provider}: respuesta vacía`);
  }
  return c;
}

/** Llamada JSON a un proceso (primario → fallback). Lanza si ambos fallan. */
export async function completeProcessJson(
  proc: string,
  system: string,
  user: string,
  opts: ProcessJsonOpts = {},
): Promise<string> {
  const cfg = getLlmConfig(proc);
  try {
    return await once(cfg.primary, proc, system, user, opts);
  } catch (e) {
    log(`${proc} primario ${cfg.primary.provider}/${cfg.primary.model} falló (${e instanceof Error ? e.message : e})`);
    if (!cfg.fallback) throw e;
    return await once(cfg.fallback, proc, system, user, { ...opts, usedFallback: true });
  }
}
