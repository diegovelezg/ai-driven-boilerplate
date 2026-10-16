import "server-only";
import fs from "node:fs";
import path from "node:path";

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
}

let cache: JsonConfig | null | undefined;

function loadJson(): JsonConfig {
  if (cache !== undefined) return cache as JsonConfig;
  const p = path.join(process.cwd(), "config", "llm_models.json");
  if (!fs.existsSync(p)) throw new Error(`llm_models.json no encontrado en ${p}`);
  const data = JSON.parse(fs.readFileSync(p, "utf-8")) as JsonConfig;
  if (!data?.providers || !data?.processes) {
    throw new Error(`Estructura inválida en ${p}: faltan providers/processes`);
  }
  cache = data;
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
  };
}
