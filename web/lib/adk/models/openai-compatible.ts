import { BaseLlm, type BaseLlmConnection, type LlmRequest, type LlmResponse } from "@google/adk";
import type { Content, Part } from "@google/genai";
import { chatCompletionParams, reasoningBody } from "@/lib/ai/llm-config";
import { createLogger } from "@/lib/log";
import { googleSchemaToJsonSchema } from "./json-schema";

const log = createLogger("adk");

export interface OpenAiCompatibleParams {
  model: string;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  reasoningEffort?: string | null;
  provider?: string;
}

function getApiKey(params: OpenAiCompatibleParams): string {
  if (params.apiKey) return params.apiKey;
  if (params.apiKeyEnv && process.env[params.apiKeyEnv]) {
    return process.env[params.apiKeyEnv] as string;
  }
  if (params.baseUrl?.includes("deepseek") && process.env.DEEPSEEK_API_KEY) {
    return process.env.DEEPSEEK_API_KEY;
  }
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  throw new Error(
    `Falta API key para '${params.model}'. Define ${params.apiKeyEnv ?? "OPENAI_API_KEY"} (o DEEPSEEK_API_KEY).`,
  );
}

/**
 * Adaptador ADK `BaseLlm` para cualquier proveedor OpenAI-compatible (OpenAI,
 * DeepSeek, Groq, …). Traduce `LlmRequest` (contents + tools) a
 * `/chat/completions` y la respuesta a `LlmResponse`. Modelo, temperatura y
 * proveedor vienen de `config/llm_models.json`; el fallback lo resuelve
 * `RoutedLlm` en `resolveModelInstance`.
 */
export class OpenAiCompatibleLlm extends BaseLlm {
  static readonly supportedModels: Array<string | RegExp> = [
    /^gpt-.*/,
    /^o1.*/,
    /^o3.*/,
    /^chatgpt-.*/,
    /^deepseek-.*/,
    /^openai\/.*/,
  ];

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly chatUrl: string;
  private readonly reasoningEffort: string | null | undefined;
  private readonly provider: string | undefined;

  constructor(params: OpenAiCompatibleParams) {
    super({ model: params.model });
    this.apiKey = getApiKey(params);
    this.baseUrl = (params.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    this.chatUrl = `${this.baseUrl}/chat/completions`;
    this.reasoningEffort = params.reasoningEffort ?? null;
    this.provider = params.provider;
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const config = (llmRequest.config as Record<string, unknown>) || {};
    const { messages, systemPrompt } = this.convertContents(llmRequest.contents, config);
    const tools = this.convertTools(llmRequest.toolsDict);

    const provider = this.provider ?? "openai";
    const model = llmRequest.model || this.model;
    const body: Record<string, unknown> = {
      model,
      messages: systemPrompt ? [{ role: "system", content: systemPrompt }, ...messages] : messages,
    };
    // Temp + tokens adaptados por proveedor (ver chatCompletionParams).
    // OJO: tools + effort≠none → 400 en luna; el agente usa effort 'none'.
    if (typeof config.temperature === "number" && typeof config.maxOutputTokens === "number") {
      Object.assign(
        body,
        chatCompletionParams(provider, model, config.temperature, config.maxOutputTokens),
      );
    } else {
      if (typeof config.temperature === "number") body.temperature = config.temperature;
      if (typeof config.maxOutputTokens === "number") body.max_tokens = config.maxOutputTokens;
    }
    if (config.responseMimeType === "application/json") {
      body.response_format = { type: "json_object" };
    }
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    if (this.reasoningEffort) {
      const provider = this.provider ?? "openai";
      Object.assign(body, reasoningBody(provider, this.model, this.reasoningEffort));
    }

    let res: Response;
    const t0 = Date.now();
    if (process.env.ADK_LOG_VERBOSE !== "0") {
      log(
        `etapa=llm_req proveedor=${provider} modelo=${model} msgs=${messages.length} tools=${tools.length} effort=${this.reasoningEffort ?? "none"}`,
      );
    }
    try {
      res = await fetch(this.chatUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: abortSignal,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "fetch failed";
      log(`etapa=llm_ERROR proveedor=${provider} modelo=${model} error=red: ${msg} ms=${Date.now() - t0}`);
      throw new Error(`${this.provider ?? "openai"} ${this.model}: ${msg}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log(
        `etapa=llm_ERROR proveedor=${provider} modelo=${model} error=HTTP ${res.status}: ${text.slice(0, 300)} ms=${Date.now() - t0}`,
      );
      throw new Error(`${this.provider ?? "openai"} ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
        };
        finish_reason?: string;
      }>;
    };
    const choice = data.choices?.[0];
    if (!choice) throw new Error("Sin choices en la respuesta OpenAI-compatible.");

    const parts: Part[] = [];
    const msg = choice.message;
    if (msg?.content) parts.push({ text: msg.content });
    if (msg?.tool_calls) {
      for (const tc of msg.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          args = {};
        }
        parts.push({ functionCall: { id: tc.id, name: tc.function.name, args } } as unknown as Part);
      }
    }
    if (parts.length === 0) parts.push({ text: "" });

    yield {
      content: { role: "model", parts },
      finishReason: choice.finish_reason as unknown as LlmResponse["finishReason"],
    };
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error("OpenAiCompatibleLlm no soporta conexiones live.");
  }

  private convertContents(
    contents: Content[],
    config?: Record<string, unknown>,
  ): { messages: Array<Record<string, unknown>>; systemPrompt?: string } {
    let systemPrompt: string | undefined;
    const si = config?.systemInstruction;
    if (typeof si === "string") systemPrompt = si;
    else if (si && typeof si === "object" && "parts" in (si as Record<string, unknown>)) {
      systemPrompt = ((si as Content).parts ?? []).map((p) => (p as { text?: string }).text || "").join("\n");
    } else if (Array.isArray(si)) {
      systemPrompt = (si as Part[]).map((p) => (p as { text?: string }).text || "").join("\n");
    }

    const messages: Array<Record<string, unknown>> = [];
    const toolCallIdMap = new Map<string, string>();
    let toolCallCounter = 0;

    for (const content of contents) {
      const role = content.role || "user";
      const parts = content.parts || [];
      const textParts: string[] = [];
      const functionCalls: Array<{ id: string; name: string; args: unknown }> = [];
      const functionResponses: Array<{ name: string; response: unknown; id?: string }> = [];

      for (const part of parts) {
        const p = part as Record<string, unknown> & {
          text?: string;
          functionCall?: { id?: string; name?: string; args?: unknown };
          functionResponse?: { id?: string; name?: string; response?: unknown };
        };
        if (p.text) textParts.push(p.text);
        if (p.functionCall) {
          const fc = p.functionCall;
          const id = fc.id || `call_${toolCallCounter++}_${fc.name}`;
          functionCalls.push({ id, name: fc.name || "", args: fc.args });
          if (fc.name) toolCallIdMap.set(fc.name, id);
        }
        if (p.functionResponse) {
          const fr = p.functionResponse;
          functionResponses.push({ name: fr.name || "", response: fr.response, id: fr.id });
        }
      }

      if (role === "user" && functionResponses.length > 0) {
        for (const fr of functionResponses) {
          const toolCallId = fr.id || toolCallIdMap.get(fr.name) || `call_${toolCallCounter++}_${fr.name}`;
          messages.push({
            role: "tool",
            tool_call_id: toolCallId,
            content: typeof fr.response === "string" ? fr.response : JSON.stringify(fr.response ?? {}),
          });
        }
        if (textParts.length > 0) messages.push({ role: "user", content: textParts.join("\n") });
      } else if (role === "model" && functionCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: textParts.join("\n") || null,
          tool_calls: functionCalls.map((fc) => ({
            id: fc.id,
            type: "function",
            function: { name: fc.name, arguments: JSON.stringify(fc.args ?? {}) },
          })),
        });
      } else if (textParts.length > 0) {
        messages.push({ role: role === "model" ? "assistant" : "user", content: textParts.join("\n") });
      }
    }

    return { messages, systemPrompt };
  }

  private convertTools(toolsDict?: Record<string, unknown>): Array<Record<string, unknown>> {
    if (!toolsDict) return [];
    const tools: Array<Record<string, unknown>> = [];
    for (const tool of Object.values(toolsDict)) {
      const t = tool as {
        name?: string;
        description?: string;
        _getDeclaration?: () => { name?: string; description?: string; parameters?: unknown };
      };
      let decl: { name?: string; description?: string; parameters?: unknown } | undefined;
      try {
        decl = t._getDeclaration?.();
      } catch {
        decl = undefined;
      }
      if (!decl?.name) {
        if (t.name) decl = { name: t.name, description: t.description };
        else continue;
      }
      const params = googleSchemaToJsonSchema(decl.parameters) || { type: "object", properties: {} };
      tools.push({
        type: "function",
        function: { name: decl.name, description: decl.description || "", parameters: params },
      });
    }
    return tools;
  }
}
