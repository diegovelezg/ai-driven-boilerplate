import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { createLogger } from "@/lib/log";

const log = createLogger("llm-usage");

function warn(line: string): void {
  log.warn(line);
}

export interface ParsedUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number | null;
}

export interface LlmUsageRow {
  storeId: string;
  process: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number | null;
  latencyMs?: number | null;
  usedFallback?: boolean;
  success?: boolean;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

/**
 * Parsea `usage` de respuestas chat no-streaming (y del chunk final SSE).
 * Tolera:
 * - OpenAI/DeepSeek: usage.{prompt_tokens,completion_tokens,total_tokens,
 *   completion_tokens_details.reasoning_tokens}
 * - Anthropic: usage.{input_tokens,output_tokens}
 * - Gemini: usageMetadata.{promptTokenCount,candidatesTokenCount,totalTokenCount}
 * Devuelve null si no hay conteo utilizable.
 */
export function parseChatUsage(data: unknown): ParsedUsage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const u = d.usage as Record<string, unknown> | undefined;
  const meta = d.usageMetadata as Record<string, unknown> | undefined;

  // OpenAI / DeepSeek / OpenAI-compatible.
  if (u && typeof u === "object") {
    const prompt = num(u.prompt_tokens) ?? num(u.input_tokens) ?? 0;
    const completion = num(u.completion_tokens) ?? num(u.output_tokens) ?? 0;
    let total = num(u.total_tokens);
    if (total === null) total = prompt + completion;
    const details = u.completion_tokens_details as Record<string, unknown> | undefined;
    const reasoning = details && typeof details === "object" ? num(details.reasoning_tokens) : null;
    if (prompt === 0 && completion === 0 && total === 0) return null;
    return { promptTokens: prompt, completionTokens: completion, totalTokens: total, reasoningTokens: reasoning };
  }

  // Gemini (usageMetadata).
  if (meta && typeof meta === "object") {
    const prompt = num(meta.promptTokenCount) ?? 0;
    const completion = num(meta.candidatesTokenCount) ?? 0;
    const total = num(meta.totalTokenCount) ?? prompt + completion;
    if (prompt === 0 && completion === 0 && total === 0) return null;
    return { promptTokens: prompt, completionTokens: completion, totalTokens: total, reasoningTokens: null };
  }

  return null;
}

/**
 * Inserta una fila en `ai_llm_usage`. Nunca lanza: sin store_id o sin Supabase
 * solo advierte (criterio de aceptacion: no perderse en silencio).
 * Fire-and-forget desde los call-sites: `void logLlmUsage(...).catch(()=>{})`.
 */
export async function logLlmUsage(row: LlmUsageRow): Promise<void> {
  try {
    if (!row.storeId) {
      warn(`skip sin store_id process=${row.process} provider=${row.provider}/${row.model}`);
      return;
    }
    if (!isSupabaseConfigured()) {
      warn(`skip sin supabase store=${row.storeId} process=${row.process}`);
      return;
    }
    const { error } = await getSupabase().from("ai_llm_usage").insert({
      store_id: row.storeId,
      process: row.process,
      provider: row.provider,
      model: row.model,
      prompt_tokens: row.promptTokens,
      completion_tokens: row.completionTokens,
      total_tokens: row.totalTokens,
      reasoning_tokens: row.reasoningTokens ?? null,
      latency_ms: row.latencyMs ?? null,
      used_fallback: row.usedFallback ?? false,
      success: row.success ?? true,
    });
    if (error) warn(`insert fallo store=${row.storeId} process=${row.process}: ${error.message}`);
  } catch (e) {
    warn(`insert excepcion process=${row.process}: ${e instanceof Error ? e.message : "?"}`);
  }
}
