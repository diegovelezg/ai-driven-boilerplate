import { BaseLlm, type BaseLlmConnection, type LlmRequest, type LlmResponse } from "@google/adk";
import type { Content, Part } from "@google/genai";
import { getAnthropicEffort } from "@/lib/ai/llm-config";
import { parseChatUsage } from "@/lib/ai/usage";
import { createLogger } from "@/lib/log";
import { googleSchemaToJsonSchema } from "./json-schema";
import { extractSystemPrompt, extractToolDeclaration, meterLlmUsage } from "./content-utils";

const log = createLogger("adk");

export interface AnthropicParams {
  model: string;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  reasoningEffort?: string | null;
  provider?: string;
}

function getApiKey(params: AnthropicParams): string {
  if (params.apiKey) return params.apiKey;
  const env = params.apiKeyEnv ?? "ANTHROPIC_API_KEY";
  if (process.env[env]) return process.env[env] as string;
  throw new Error(`Falta ${env} para Anthropic (${params.model}).`);
}

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

/**
 * Adaptador ADK `BaseLlm` para la Messages API de Anthropic (`/v1/messages`),
 * que no es OpenAI-compatible. Traduce `LlmRequest` a bloques de contenido con
 * `tool_use`/`tool_result`.
 *
 * Esfuerzo SOLO-DOCS (sin ANTHROPIC_API_KEY para smoke, 2026-10-16):
 * docs `platform.claude.com/.../effort` → `output_config.effort` (low|medium|high|xhigh|max)
 * + `thinking:{type:"adaptive"}`. El antiguo `budget_tokens` está deprecado (4.6) y
 * devuelve 400 en 4.7+, por eso ya no se envía.
 * El fallback lo resuelve `RoutedLlm` en `resolveModelInstance`.
 */
export class AnthropicLlm extends BaseLlm {
  static readonly supportedModels: Array<string | RegExp> = [/^claude-.*/, /^anthropic\/.*/];

  private readonly apiKey: string;
  private readonly messagesUrl: string;
  private readonly reasoningEffort: string | null | undefined;

  constructor(params: AnthropicParams) {
    super({ model: params.model });
    this.apiKey = getApiKey(params);
    const base = (params.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
    this.messagesUrl = base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
    this.reasoningEffort = params.reasoningEffort ?? null;
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const config = (llmRequest.config as Record<string, unknown>) || {};
    const { messages, systemPrompt } = this.convertContents(llmRequest.contents, config);
    const tools = this.convertTools(llmRequest.toolsDict);

    const maxTokens = typeof config.maxOutputTokens === "number" ? config.maxOutputTokens : 4096;
    const body: Record<string, unknown> = {
      model: llmRequest.model || this.model,
      max_tokens: maxTokens,
      messages,
    };
    if (systemPrompt) body.system = systemPrompt;
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = { type: "auto" };
    }

    if (this.reasoningEffort) {
      // Solo-docs: effort gobierna todo el gasto de tokens (incluido thinking).
      body.output_config = { effort: getAnthropicEffort(this.reasoningEffort) };
      body.thinking = { type: "adaptive" };
    }
    if (typeof config.temperature === "number" && !this.reasoningEffort) {
      body.temperature = config.temperature;
    }

    let res: Response;
    const t0 = Date.now();
    const model = String(llmRequest.model || this.model);
    if (process.env.ADK_LOG_VERBOSE !== "0") {
      log(`etapa=llm_req proveedor=anthropic modelo=${model} msgs=${messages.length} tools=${tools.length}`);
    }
    try {
      res = await fetch(this.messagesUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        // Ningún caller pasa abortSignal: deadline propia de 120s para no
        // colgar el chat de la UI para siempre. Respeta la externa si llega.
        signal: abortSignal ?? AbortSignal.timeout(120_000),
      });
    } catch (e) {
      if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
        const msg = "anthropic: timeout (120s) sin respuesta";
        log(`etapa=llm_ERROR proveedor=anthropic modelo=${model} error=${msg} ms=${Date.now() - t0}`);
        throw new Error(`anthropic ${this.model}: ${msg}`);
      }
      const msg = e instanceof Error ? e.message : "fetch failed";
      log(`etapa=llm_ERROR proveedor=anthropic modelo=${model} error=red: ${msg} ms=${Date.now() - t0}`);
      throw new Error(`anthropic ${this.model}: ${msg}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log(
        `etapa=llm_ERROR proveedor=anthropic modelo=${model} error=HTTP ${res.status}: ${text.slice(0, 300)} ms=${Date.now() - t0}`,
      );
      throw new Error(`anthropic ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      content?: Array<
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; input: unknown }
        | { type: string }
      >;
      stop_reason?: string;
      usage?: unknown;
      usageMetadata?: unknown;
    };
    const usage = parseChatUsage(data);
    meterLlmUsage(config, usage, { provider: "anthropic", model, t0 });

    const parts: Part[] = [];
    for (const block of data.content ?? []) {
      if (block.type === "text") {
        const text = (block as { text: string }).text;
        if (text) parts.push({ text });
      } else if (block.type === "tool_use") {
        const tu = block as { id: string; name: string; input: unknown };
        parts.push({ functionCall: { id: tu.id, name: tu.name, args: tu.input } } as unknown as Part);
      }
      // Los bloques de thinking/redacted_thinking se ignoran en la respuesta.
    }
    if (parts.length === 0) parts.push({ text: "" });

    yield {
      content: { role: "model", parts },
      finishReason: data.stop_reason as unknown as LlmResponse["finishReason"],
    };
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error("AnthropicLlm no soporta conexiones live.");
  }

  private convertContents(
    contents: Content[],
    config?: Record<string, unknown>,
  ): { messages: Array<{ role: "user" | "assistant"; content: Block[] }>; systemPrompt?: string } {
    const systemPrompt = extractSystemPrompt(config);

    const messages: Array<{ role: "user" | "assistant"; content: Block[] }> = [];
    const toolCallIdMap = new Map<string, string>();
    let toolCounter = 0;

    for (const content of contents) {
      const role: "user" | "assistant" = content.role === "model" ? "assistant" : "user";
      const textParts: string[] = [];
      const toolUses: Array<{ id: string; name: string; args: unknown }> = [];
      const toolResults: Array<{ id: string; content: string }> = [];

      for (const part of content.parts ?? []) {
        const p = part as Record<string, unknown> & {
          text?: string;
          functionCall?: { id?: string; name?: string; args?: unknown };
          functionResponse?: { id?: string; name?: string; response?: unknown };
        };
        if (p.text) textParts.push(p.text);
        if (p.functionCall) {
          const fc = p.functionCall;
          const id = fc.id || `toolu_${toolCounter++}_${fc.name}`;
          toolUses.push({ id, name: fc.name || "", args: fc.args });
          if (fc.name) toolCallIdMap.set(fc.name, id);
        }
        if (p.functionResponse) {
          const fr = p.functionResponse;
          const id = fr.id || (fr.name ? toolCallIdMap.get(fr.name) : undefined) || `toolu_${toolCounter++}`;
          toolResults.push({
            id,
            content: typeof fr.response === "string" ? fr.response : JSON.stringify(fr.response ?? {}),
          });
        }
      }

      const blocks: Block[] = [];
      if (role === "assistant") {
        for (const t of textParts) blocks.push({ type: "text", text: t });
        for (const tu of toolUses) blocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.args });
      } else {
        // Anthropic exige que los tool_result vayan antes que el texto.
        for (const tr of toolResults) blocks.push({ type: "tool_result", tool_use_id: tr.id, content: tr.content });
        for (const t of textParts) blocks.push({ type: "text", text: t });
      }
      if (blocks.length === 0) continue;

      const last = messages[messages.length - 1];
      if (last && last.role === role) last.content.push(...blocks);
      else messages.push({ role, content: blocks });
    }

    return { messages, systemPrompt };
  }

  private convertTools(toolsDict?: Record<string, unknown>): Array<Record<string, unknown>> {
    if (!toolsDict) return [];
    const tools: Array<Record<string, unknown>> = [];
    for (const tool of Object.values(toolsDict)) {
      const decl = extractToolDeclaration(tool);
      if (!decl) continue;
      tools.push({
        name: decl.name,
        description: decl.description || "",
        input_schema: googleSchemaToJsonSchema(decl.parameters) || { type: "object", properties: {} },
      });
    }
    return tools;
  }
}
