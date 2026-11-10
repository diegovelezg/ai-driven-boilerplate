import type { Content, Part } from "@google/genai";
import { logLlmUsage, type ParsedUsage } from "@/lib/ai/usage";

// Lógica compartida por los adaptadores ADK (`anthropic.ts` y
// `openai-compatible.ts`). Puro y testeable: la traducción a cada wire
// format vive en cada adaptador (bloques vs mensajes OpenAI difieren, y el
// orden de generación de ids sintéticos también).

/** systemInstruction → texto plano (string | Content con parts | Part[]). */
export function extractSystemPrompt(config?: Record<string, unknown>): string | undefined {
  const si = config?.systemInstruction;
  if (typeof si === "string") return si;
  if (si && typeof si === "object" && "parts" in (si as Record<string, unknown>)) {
    return ((si as Content).parts ?? []).map((p) => (p as { text?: string }).text || "").join("\n");
  }
  if (Array.isArray(si)) {
    return (si as Part[]).map((p) => (p as { text?: string }).text || "").join("\n");
  }
  return undefined;
}

export interface ToolDeclaration {
  name: string;
  description?: string;
  parameters?: unknown;
}

/** Declaración de tool ADK (vía `_getDeclaration()` o nombre/descripción
 *  planos). undefined = sin nombre utilizable (el caller la salta). */
export function extractToolDeclaration(tool: unknown): ToolDeclaration | undefined {
  const t = tool as {
    name?: string;
    description?: string;
    _getDeclaration?: () => { name?: string; description?: string; parameters?: unknown };
  };
  let resolved: { name: string; description?: string; parameters?: unknown } | undefined;
  try {
    const d = t._getDeclaration?.();
    if (d?.name) resolved = { name: d.name, description: d.description, parameters: d.parameters };
  } catch {
    resolved = undefined;
  }
  if (!resolved && t.name) resolved = { name: t.name, description: t.description };
  if (!resolved) return undefined;
  return resolved;
}

/** Medición de uso LLM (no-op sin storeId en config o sin usage). Misma
 *  redacción y fallbacks que el bloque inline que reemplaza en ambos
 *  adaptadores (process default `customer_chat`). */
export function meterLlmUsage(
  config: Record<string, unknown>,
  usage: ParsedUsage | null | undefined,
  opts: { provider: string; model: string; t0: number },
): void {
  const meterStoreId = typeof config.storeId === "string" ? config.storeId : null;
  const meterProcess = typeof config.process === "string" ? config.process : "customer_chat";
  if (meterStoreId && usage) {
    void logLlmUsage({
      storeId: meterStoreId,
      process: meterProcess,
      provider: opts.provider,
      model: opts.model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      reasoningTokens: usage.reasoningTokens,
      latencyMs: Date.now() - opts.t0,
    });
  }
}
