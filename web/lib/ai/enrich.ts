// Sin `import "server-only"`: lo importan el worker dedicado (`worker.ts`,
// issue #24) y scripts tsx en node, donde `server-only` lanza. Nunca importar
// en Client Components (maneja API keys de LLM en server).
import { createLogger } from "../log";
import { chatCompletionParams, getLlmConfig, reasoningBody, type ModelRef } from "./llm-config";
import { logLlmUsage, parseChatUsage } from "./usage";

const log = createLogger("enrichment");

export interface FirmographicsResult {
  companyName: string | null;
  industry: string | null;
  description: string | null;
  size: string | null;
  location: string | null;
  confidence: number | null;
  /** provider/model que respondió (para trazabilidad en `domains.model`). */
  model: string;
}

const SYSTEM = `Eres un analista que extrae la ficha de una empresa a partir del texto de su web.
Responde SOLO con un objeto JSON válido, sin markdown, con este esquema exacto:
{"company_name": string|null, "industry": string|null, "description": string|null, "size": string|null, "location": string|null, "confidence": number}
Reglas:
- "description": máximo 240 caracteres, 1-2 frases.
- "size": usa "micro","pequeña","mediana" o "grande"; null si no es deducible.
- "location": ciudad/país si aparece.
- "confidence": número entre 0 y 1.
- Si un dato no se deduce del texto, usa null. NO inventes.`;

async function complete(
  ref: ModelRef,
  messages: Array<{ role: string; content: string }>,
  temperature: number,
  maxTokens: number,
  reasoningEffort?: string | null,
  jsonMode: "none" | "native" = "native",
  meter?: { storeId?: string | null; process?: string; usedFallback?: boolean },
): Promise<string> {
  const apiKey = ref.apiKeyEnv ? process.env[ref.apiKeyEnv] : undefined;
  if (!apiKey) throw new Error(`Falta ${ref.apiKeyEnv}`);
  const base = (ref.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const body: Record<string, unknown> = {
    model: ref.model,
    messages,
    ...chatCompletionParams(ref.provider, ref.model, temperature, maxTokens),
  };
  if (jsonMode === "native") body.response_format = { type: "json_object" };
  Object.assign(body, reasoningBody(ref.provider, ref.model, reasoningEffort));
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      // Sin timeout el caller se queda colgado para siempre. 120s cubre reasoning lento.
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new Error(`${ref.provider}: timeout (120s) sin respuesta`);
    }
    throw e;
  }
  if (!res.ok) {
    throw new Error(`${ref.provider} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  const usage = parseChatUsage(data);
  if (meter?.storeId && usage) {
    void logLlmUsage({
      storeId: meter.storeId,
      process: meter.process ?? "enrichment",
      provider: ref.provider,
      model: ref.model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      reasoningTokens: usage.reasoningTokens,
      latencyMs: Date.now() - t0,
      usedFallback: meter.usedFallback ?? false,
    });
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error(`${ref.provider}: respuesta vacía`);
  }
  return content;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Extrae firmográficos de un dominio a partir del texto de su web (primario → fallback). */
export async function extractFirmographics(
  domain: string,
  text: string,
  opts: { storeId?: string | null } = {},
): Promise<FirmographicsResult> {
  const cfg = getLlmConfig("enrichment");
  const messages = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `Dominio: ${domain}\n\nTexto de la web (recortado):\n${text.slice(0, 6000)}`,
    },
  ];

  let content: string;
  let used: ModelRef;
  let usedFallback = false;
  try {
    used = cfg.primary;
    content = await complete(cfg.primary, messages, cfg.temperature, cfg.maxTokens, cfg.reasoningEffort, cfg.jsonMode, { storeId: opts.storeId, process: "enrichment" });
  } catch (e) {
    if (!cfg.fallback) throw e;
    log.child({ storeId: opts.storeId ?? null })(`capa=extract primario ${cfg.primary.model} falló (${e instanceof Error ? e.message : e}); fallback a ${cfg.fallback.model}`);
    used = cfg.fallback;
    usedFallback = true;
    content = await complete(cfg.fallback, messages, cfg.temperature, cfg.maxTokens, cfg.reasoningEffort, cfg.jsonMode, { storeId: opts.storeId, process: "enrichment", usedFallback });
  }

  const parsed = JSON.parse(content) as Record<string, unknown>;
  return {
    companyName: str(parsed.company_name),
    industry: str(parsed.industry),
    description: str(parsed.description),
    size: str(parsed.size),
    location: str(parsed.location),
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
    model: `${used.provider}/${used.model}`,
  };
}
