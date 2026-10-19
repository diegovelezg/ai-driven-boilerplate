import fs from "node:fs";
import path from "node:path";

/** Prefijos OpenAI estilo reasoning (ver shouldSendReasoningEffort / isReasoningChatModel). */
const OPENAI_REASONING_PREFIXES = ["o1", "o3", "o4", "gpt-5", "gpt-6"];

export type QualityTier = "alta" | "media" | "economica";

interface JsonModelRef {
  provider: string;
  model: string;
  quality: QualityTier;
}

interface JsonProvider {
  api_key_env: string;
  backend: string;
  base_url?: string;
}

interface JsonProcess {
  primary: JsonModelRef;
  fallback?: JsonModelRef | null;
  temperature?: number;
  max_tokens?: number;
  /** Esfuerzo de razonamiento normalizado (low|medium|high|max|none). Opcional. */
  reasoning_effort?: string | null;
  /** none = texto libre; native = response_format json_object. Opcional. */
  json_mode?: string | null;
}

interface JsonConfig {
  providers: Record<string, JsonProvider>;
  processes: Record<string, JsonProcess>;
}

const QUALITIES: readonly QualityTier[] = ["alta", "media", "economica"];

export interface ModelRef {
  provider: string;
  backend: string;
  model: string;
  quality: QualityTier;
  apiKeyEnv: string;
  baseUrl?: string;
}

export interface ProcessLlmConfig {
  process: string;
  primary: ModelRef;
  fallback: ModelRef | null;
  temperature: number;
  maxTokens: number;
  reasoningEffort: string | null;
  jsonMode: "none" | "native";
}

const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high", "max", "none"]);
const VALID_JSON_MODES = new Set(["none", "native"]);

/**
 * Modelos chat estilo reasoning en OpenAI (o1/o3/o4/gpt-5/gpt-6):
 * verificado 2026-10-16 con gpt-6-luna: rechazan `max_tokens` (usar
 * `max_completion_tokens`) y `temperature != 1` (omitir). Aplica al
 * primario y a cualquier fallback con estos prefijos.
 */
function isReasoningChatModel(provider: string, model: string): boolean {
  return provider === "openai" && OPENAI_REASONING_PREFIXES.some((p) => model.startsWith(p));
}

/**
 * Niveles nativos por proveedor. Fuentes (no memoria):
 * - deepseek: `GET /models` empírico (2026-10-16) → `effort.supported_levels: ["low","high","max"]`,
 *   default "high". Sin "medium": el normalizado "medium" se mapea a "high" (nivel superior
 *   más cercano; coincide con el default del proveedor). Sonda: `deepseek-chat` acepta con 200
 *   cualquier `reasoning_effort` (ignora inválidos) y `thinking:{type:"enabled"}` sí devuelve
 *   `reasoning_content`.
 * - openai: docs `platform.openai.com/docs/guides/reasoning` → valores por modelo:
 *   none|minimal|low|medium|high|xhigh|max. Sonda empírica: `gpt-4o-mini` devuelve 400
 *   "Unrecognized request argument supplied: reasoning_effort" → no se le envía.
 * - anthropic: docs `platform.claude.com/docs/en/build-with-claude/effort` → `output_config.effort`:
 *   low|medium|high|xhigh|max. `budget_tokens` deprecado (4.6) / 400 en 4.7+ → no se usa.
 *   Sin key disponible: mapeo solo-docs, sin smoke.
 * - gemini: sin key y docs inaccesibles → NO VERIFICADO: no se envía thinking custom.
 */
const REASONING_EFFORT_NATIVE: Record<string, Record<string, string>> = {
  openai: { low: "low", medium: "medium", high: "high", max: "max" },
  deepseek: { low: "low", medium: "high", high: "high", max: "max" },
  anthropic: { low: "low", medium: "medium", high: "high", max: "max" },
};

function getNativeReasoningEffort(provider: string, normalized: string): string {
  const mapping = REASONING_EFFORT_NATIVE[provider];
  if (!mapping) return normalized;
  return mapping[normalized] ?? normalized;
}

/** Modelos OpenAI que aceptan `reasoning_effort` (docs: solo reasoning models). Resto → omitir. */

/**
 * ¿Se debe enviar `reasoning_effort` (Chat Completions) a este modelo?
 * Empírico: `gpt-4o-mini` → 400 si se envía. `deepseek-*` → 200 siempre (acepta/ignora).
 */
function shouldSendReasoningEffort(provider: string, model: string): boolean {
  if (provider === "openai") {
    return OPENAI_REASONING_PREFIXES.some((p) => model.startsWith(p));
  }
  if (provider === "deepseek") return true;
  return false;
}

/** Esfuerzo Anthropic (`output_config.effort`). Solo-docs (sin key para smoke). */
export function getAnthropicEffort(normalized: string): string {
  return REASONING_EFFORT_NATIVE.anthropic[normalized] ?? normalized;
}

/**
 * Fragmento body para esfuerzo de razonamiento. 'none' = sin thinking:
 * solo se envía explícito a reasoning models OpenAI (obligatorio para
 * tools en gpt-6-luna); en el resto se omite (off por defecto).
 */
export function reasoningBody(
  provider: string,
  model: string,
  effort: string | null | undefined,
): Record<string, unknown> {
  if (!effort || !shouldSendReasoningEffort(provider, model)) return {};
  if (effort === "none") {
    return isReasoningChatModel(provider, model) ? { reasoning_effort: "none" } : {};
  }
  const out: Record<string, unknown> = {
    reasoning_effort: getNativeReasoningEffort(provider, effort),
  };
  if (provider === "deepseek") out.thinking = { type: "enabled" };
  return out;
}

/**
 * Temperatura + límite de tokens adaptados al proveedor/modelo
 * (verificado 2026-10-16, no memoria):
 * - OpenAI reasoning (o1/o3/o4/gpt-5/gpt-6, incl. gpt-6-luna): sin
 *   `temperature` custom (solo aceptan 1 → se omite) y
 *   `max_completion_tokens` en vez de `max_tokens` (400 en caso contrario).
 * - Resto (deepseek verificado con 200): `temperature` + `max_tokens` tal cual.
 * Reglas nuevas solo entran aquí tras sonda empírica, nunca hardcodeadas
 * en los senders.
 */
export function chatCompletionParams(
  provider: string,
  model: string,
  temperature: number,
  maxTokens: number,
): Record<string, unknown> {
  if (isReasoningChatModel(provider, model)) {
    return { max_completion_tokens: maxTokens };
  }
  return { temperature, max_tokens: maxTokens };
}

/**
 * Bloque `thinkingConfig` para Gemini.
 * NO VERIFICADO (sin key, docs inaccesibles 2026-10-16) → siempre undefined:
 * no se envía thinking custom hasta poder hacer smoke.
 */
export function getGeminiThinkingConfig(
  _provider: string,
  _effort: string | null | undefined,
): Record<string, unknown> | undefined {
  return undefined;
}

let cache: { mtimeMs: number; data: JsonConfig } | undefined;

function loadJson(): JsonConfig {
  const p = path.join(process.cwd(), "config", "llm_models.json");
  // Recarga por mtime: el JSON se edita en disco sin redeploy (dev/HMR) y el
  // cache en memoria quedaría rancio (ya tumbó una corrida de prospección).
  const mtimeMs = fs.statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  if (cache !== undefined && cache.mtimeMs === mtimeMs) return cache.data;
  if (!fs.existsSync(p)) throw new Error(`llm_models.json no encontrado en ${p}`);
  const data = JSON.parse(fs.readFileSync(p, "utf-8")) as JsonConfig;
  if (!data?.providers || !data?.processes) {
    throw new Error(`Estructura inválida en ${p}: faltan providers/processes`);
  }
  cache = { mtimeMs, data };
  return data;
}

function toModelRef(ref: JsonModelRef, providers: Record<string, JsonProvider>): ModelRef {
  const prov = providers[ref.provider];
  if (!prov) throw new Error(`Provider '${ref.provider}' no definido en providers`);
  if (!QUALITIES.includes(ref.quality)) {
    throw new Error(`Quality '${ref.quality}' inválida (alta|media|economica)`);
  }
  return {
    provider: ref.provider,
    backend: prov.backend,
    model: ref.model,
    quality: ref.quality,
    apiKeyEnv: prov.api_key_env,
    baseUrl: prov.base_url,
  };
}

/** Config resuelta para un proceso (p.ej. customer_chat). Lanza si falta. */
export function getLlmConfig(process: string): ProcessLlmConfig {
  const data = loadJson();
  const entry = data.processes[process];
  if (!entry) {
    throw new Error(
      `Proceso '${process}' no declarado en llm_models.json. Conocidos: ${Object.keys(data.processes).join(", ")}`,
    );
  }
  return {
    process,
    primary: toModelRef(entry.primary, data.providers),
    fallback: entry.fallback ? toModelRef(entry.fallback, data.providers) : null,
    temperature: entry.temperature ?? 0.4,
    maxTokens: entry.max_tokens ?? 1500,
    reasoningEffort: (() => {
      const re = entry.reasoning_effort ?? null;
      if (re !== null && !VALID_REASONING_EFFORTS.has(re)) {
        throw new Error(
          `Proceso '${process}' tiene reasoning_effort inválido: '${re}' (usa low|medium|high|max|none)`,
        );
      }
      return re;
    })(),
    jsonMode: (() => {
      const jm = entry.json_mode ?? "none";
      if (!VALID_JSON_MODES.has(jm)) {
        throw new Error(`Proceso '${process}' tiene json_mode inválido: '${jm}' (usa none|native)`);
      }
      return jm as "none" | "native";
    })(),
  };
}
