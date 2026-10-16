import { Gemini, RoutedLlm, type BaseLlm } from "@google/adk";
import type { ModelRef, ProcessLlmConfig } from "@/lib/ai/llm-config";
import { OpenAiCompatibleLlm } from "@/lib/adk/models/openai-compatible";
import { AnthropicLlm } from "@/lib/adk/models/anthropic";

function env(ref: ModelRef): string | undefined {
  return ref.apiKeyEnv ? process.env[ref.apiKeyEnv] : undefined;
}

/** Instancia el `BaseLlm` del proveedor según su `backend`. */
function build(ref: ModelRef, reasoningEffort: string | null): BaseLlm {
  switch (ref.backend) {
    case "openai":
      return new OpenAiCompatibleLlm({
        model: ref.model,
        apiKey: env(ref),
        apiKeyEnv: ref.apiKeyEnv,
        baseUrl: ref.baseUrl,
        reasoningEffort,
        provider: ref.provider,
      });
    case "anthropic":
      return new AnthropicLlm({
        model: ref.model,
        apiKey: env(ref),
        apiKeyEnv: ref.apiKeyEnv,
        baseUrl: ref.baseUrl,
        reasoningEffort,
        provider: ref.provider,
      });
    case "google.genai":
      return new Gemini({ model: ref.model, ...(env(ref) ? { apiKey: env(ref) } : {}) });
    default:
      throw new Error(`Backend '${ref.backend}' no soportado (provider '${ref.provider}').`);
  }
}

/**
 * Construye el `model` de un `LlmAgent` desde la config del proceso
 * (`config/llm_models.json`): instancia el proveedor primario y, si hay
 * fallback, los combina con `RoutedLlm` para failover entre proveedores
 * (openai / anthropic / gemini) ante error del primario.
 */
export function resolveModelInstance(cfg: ProcessLlmConfig): BaseLlm {
  const primary = build(cfg.primary, cfg.reasoningEffort);
  if (!cfg.fallback) return primary;

  const fallback = build(cfg.fallback, cfg.reasoningEffort);
  return new RoutedLlm({
    models: { primary, fallback },
    router: (_models, _request, errorContext) => {
      if (!errorContext) return "primary";
      if (!errorContext.failedKeys.has("fallback")) return "fallback";
      return undefined;
    },
  });
}
