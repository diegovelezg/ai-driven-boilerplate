import "server-only";
import { chatCompletionParams, getLlmConfig, reasoningBody, type ModelRef } from "./llm-config";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function chatUrl(ref: ModelRef): string {
  const base = (ref.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  return `${base}/chat/completions`;
}

async function postStream(
  ref: ModelRef,
  messages: ChatMessage[],
  temperature: number,
  maxTokens: number,
  signal?: AbortSignal,
  reasoningEffort?: string | null,
  jsonMode: "none" | "native" = "none",
): Promise<Response> {
  const apiKey = ref.apiKeyEnv ? process.env[ref.apiKeyEnv] : undefined;
  if (!apiKey) {
    return new Response(`Falta ${ref.apiKeyEnv} en .env.local`, { status: 503 });
  }
  const body: Record<string, unknown> = {
    model: ref.model,
    messages,
    ...chatCompletionParams(ref.provider, ref.model, temperature, maxTokens),
    stream: true,
  };
  if (jsonMode === "native") body.response_format = { type: "json_object" };
  Object.assign(body, reasoningBody(ref.provider, ref.model, reasoningEffort));
  return fetch(chatUrl(ref), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * Chat streaming con fallback (espejo de OpenAiCompatibleLlm de dooh-ai):
 * primario -> si falla (red o !ok), un intento contra el fallback.
 * Devuelve el stream SSE tal cual para pipearlo al cliente.
 */
export async function streamChat(
  process: string,
  messages: ChatMessage[],
  opts: { signal?: AbortSignal } = {},
): Promise<{ response: Response; usedFallback: boolean }> {
  const cfg = getLlmConfig(process);
  let res = await postStream(
    cfg.primary,
    messages,
    cfg.temperature,
    cfg.maxTokens,
    opts.signal,
    cfg.reasoningEffort,
    cfg.jsonMode,
  ).catch((e) => new Response(e instanceof Error ? e.message : "fetch failed", { status: 502 }));

  if ((!res.ok || !res.body) && cfg.fallback) {
    console.warn(
      `[llm] primario ${cfg.primary.provider}/${cfg.primary.model} falló (${res.status}). Fallback a ${cfg.fallback.provider}/${cfg.fallback.model}`,
    );
    res = await postStream(
      cfg.fallback,
      messages,
      cfg.temperature,
      cfg.maxTokens,
      opts.signal,
      cfg.reasoningEffort,
      cfg.jsonMode,
    ).catch(
      (e) => new Response(e instanceof Error ? e.message : "fetch failed", { status: 502 }),
    );
    return { response: res, usedFallback: true };
  }
  return { response: res, usedFallback: false };
}
