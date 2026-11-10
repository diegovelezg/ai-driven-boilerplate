import { chatCompletionParams, getLlmConfig, reasoningBody, type ModelRef } from "./llm-config";
import { logLlmUsage, parseChatUsage } from "./usage";
// Logger sin "server-only" (el set perfilador corre también en smoke tsx).
import { createProfilerLogger } from "@/lib/profiling/log";
import { isKnownTaxonomyId, taxonomyPromptFragment } from "@/lib/taxonomy";
import type { DescriptionInterpretation } from "@/lib/profile-interpreter";
import { fetchHomepageText } from "@/lib/fetch-text";

const log = createProfilerLogger();

export interface InvestigateSources {
  url: string;
  chars: number;
}

export interface InvestigateResult extends DescriptionInterpretation {
  /** Mapeo a taxonomía (juicio del agente; null = sin encaje honesto). */
  taxonomyId: string | null;
  sources: InvestigateSources | null;
  /** Texto web recortado (para el synthesizer; NO serializar al cliente). */
  webText: string | null;
}

/** Extrae la primera URL o dominio suelto del texto libre ("mi web es tupantalla.com").
 *  Normaliza acentos para el match ("tupàntalla.com" → "tupantalla.com"). */
function extractWebsite(raw: string): string | null {
  const text = (raw ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const urlMatch = text.match(/https?:\/\/[^\s),;]+/i);
  if (urlMatch) {
    try {
      const u = new URL(urlMatch[0]);
      if (u.hostname.includes(".")) return u.hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      // sigue a dominio suelto
    }
  }
  const domainMatch = text.match(/(?:^|[\s(,;])([a-z0-9-]+\.(?:com|pe|com\.pe|io|co|net|org|shop|store|lat|dev)(?:\.[a-z]{2})?)(?:[\s),;]|$)/i);
  if (domainMatch) return domainMatch[1].toLowerCase().replace(/^www\./, "");
  return null;
}

const SYSTEM = `Eres un analista que tipifica un negocio B2B para un tenant DOOH (anunciante, agencia o proveedor de pantallas).
Responde SOLO con un objeto JSON válido, sin markdown, con este esquema exacto:
{"business_model": "b2b"|null, "vertical": string|null, "taxonomy_id": string|null, "buyer_type": string|null, "cycle_days": number|null, "cycle_unknown": boolean, "industry": "alimentos"|"moda"|"belleza"|"hogar"|"electronica"|"salud"|"mascotas"|"servicios"|"distribucion"|"otro"|null, "catalog_type": "consumible"|"perecedero"|"moda_estacional"|"durable"|"servicio"|"digital"|"mixto"|null, "archetype": "b2b_recurrente"|"b2b_proyecto"|null, "company_required": true, "confidence": "alta"|"media"|"baja", "understood": string[], "questions": string[]}
Reglas:
- Sistema B2B-only: business_model siempre "b2b", archetype b2b_recurrente (reposición) o b2b_proyecto (esporádica), company_required siempre true.
- vertical: LA VERDAD PRIMARIA, texto libre en español (máx 60 caracteres, p.ej. "publicidad en vía pública", "café de especialidad"). Siempre que se deduzca algo, rellénalo con tus palabras.
- taxonomy_id: mapea tu "vertical" a UNO de los verticales de abajo, o null si ninguno encaja. Null honesto antes que forzado.
- buyer_type: granularidad del comprador si se deduce ("consumidor final", "negocio pequeño", "empresa mediana", "corporativo"); null si no.
- industry: legado, solo como hint grueso cuando encaje obvio; si no, null. NUNCA fuerces un valor de lista.
- archetype b2b_recurrente (reposición 45d) o b2b_proyecto (esporádica 135d).
- cycle_days: recompra típica en días si se deduce (suscripción mensual=30, moda por temporada=120, durable=270, reposición B2B=45, proyecto=135); null si no se deduce.
- cycle_unknown: true SOLO si el merchant dice explícitamente que varía o no sabe ("varía", "por campaña", "no sé"). Es "respondido sin número", distinto de hueco.
- understood: 1-4 frases en español de lo entendido. questions: máx 3 para afinar.
- understood son SOLO hechos concretos extraídos (qué vende, a quién, su web). JAMÁS meta-incertidumbre ("el nombre sugiere pero no permite saber", "por sí solos no identifican"): si no hay nada concreto, understood=[] y la duda va en questions.
- El Contexto (si hay) son datos de apoyo para orientar tus questions: no los recites en understood.
- Si un dato no se deduce, usa null. NO inventes.

${taxonomyPromptFragment()}`;

async function completeJson(
  ref: ModelRef,
  system: string,
  user: string,
  opts: { storeId?: string | null; usedFallback?: boolean } = {},
): Promise<string> {
  const resolved = getLlmConfig("customer_classify");
  const apiKey = ref.apiKeyEnv ? process.env[ref.apiKeyEnv] : undefined;
  if (!apiKey) throw new Error(`Falta ${ref.apiKeyEnv}`);
  const base = (ref.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  // deepseek con thinking trunca/vacía (empírico): el fallback va sin thinking.
  const effort = ref.provider === "deepseek" ? null : resolved.reasoningEffort;
  const body: Record<string, unknown> = {
    model: ref.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    ...chatCompletionParams(ref.provider, ref.model, resolved.temperature, resolved.maxTokens),
    response_format: { type: "json_object" },
    ...reasoningBody(ref.provider, ref.model, effort),
  };
  const t0 = Date.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`${ref.provider} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const choice = data?.choices?.[0] ?? {};
  const content = choice?.message?.content;
  const usage = parseChatUsage(data);
  if (opts.storeId && usage) {
    void logLlmUsage({
      storeId: opts.storeId,
      process: "customer_classify",
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
  if (typeof content !== "string" || !content.trim()) {
    log(`investigate ${ref.provider}/${ref.model} vacía: finish=${choice?.finish_reason ?? "?"} usage=${JSON.stringify(data?.usage?.completion_tokens_details ?? null)}`);
    throw new Error(`${ref.provider}: respuesta vacía`);
  }
  return content;
}

const VALID_INDUSTRIES = new Set([
  "alimentos", "moda", "belleza", "hogar", "electronica", "salud", "mascotas", "servicios", "distribucion", "otro",
]);
const VALID_CATALOGS = new Set([
  "consumible", "perecedero", "moda_estacional", "durable", "servicio", "digital", "mixto",
]);
const VALID_CONF = new Set(["alta", "media", "baja"]);

/**
 * Investiga el negocio: si la descripción trae web, la abre y la usa como
 * evidencia principal; si no, tipifica solo con la descripción (mejor que
 * keywords, con el mismo contrato que el intérprete local).
 * `extraContext` = evidencia que no debe re-preguntarse (p.ej. señales de datos).
 */
export async function investigateBusiness(
  description: string,
  extraContext?: string,
  opts: { storeId?: string | null } = {},
): Promise<InvestigateResult> {
  const desc = (description ?? "").trim();
  if (desc.length < 10) throw new Error("Describe tu negocio en al menos una frase (10 caracteres).");

  // Solo dominios exactos. Sin guess, sin normalizaciones, sin reglas de
  // preferencia: si no hay dominio pegado, no hay fetch y se pregunta.
  // Equivocarse con confianza es peor que preguntar una vez.
  const target = extractWebsite(desc);
  const page = target ? await fetchHomepageText(target, 6000) : null;
  log(`investigate input=${desc.slice(0, 80)} domain=${target} fetch=${page ? `${page.url} ${page.text.length}ch` : "fallo"}`);
  const verifiedCtx =
    page && target ? `Web verificada: ${target} (es la web del negocio; ignora variantes de dominio mencionadas antes).` : "";

  const cfg = getLlmConfig("customer_classify");
  const ctxParts = [verifiedCtx, (extraContext ?? "").trim().slice(0, 500)].filter(Boolean);
  const ctx = ctxParts.join("\n");
  const user = page
    ? `Descripción del merchant:\n${desc.slice(0, 1500)}\n\nWeb ${page.url} (texto recortado):\n${page.text}${ctx ? `\n\nContexto (no re-preguntes lo que esto ya dice):\n${ctx}` : ""}`
    : `Descripción del merchant (sin web accesible${target ? `; ${target} no respondió` : ""}):\n${desc.slice(0, 1500)}${ctx ? `\n\nContexto (no re-preguntes lo que esto ya dice):\n${ctx}` : ""}`;

  async function callOnce(): Promise<string> {
    try {
      return await completeJson(cfg.primary, SYSTEM, user, { storeId: opts.storeId });
    } catch (e) {
      log(`investigate primario ${cfg.primary.provider}/${cfg.primary.model} falló (${e instanceof Error ? e.message : e})`);
      if (!cfg.fallback) throw e;
      return await completeJson(cfg.fallback, SYSTEM, user, { storeId: opts.storeId, usedFallback: true });
    }
  }

  // Un reintento ante JSON truncado (glitch de proveedor): lo cortado no se parsea.
  let content = await callOnce();
  try {
    JSON.parse(content);
  } catch {
    log(`investigate JSON truncado, reintento (head=${content.slice(0, 120)})`);
    content = await callOnce();
  }

  const p = JSON.parse(content) as Record<string, unknown>;
  const asStr = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  const businessModel = asStr(p.business_model);
  const vertical = asStr(p.vertical)?.slice(0, 80) ?? null;
  const taxonomyRaw = asStr(p.taxonomy_id);
  const taxonomyId = isKnownTaxonomyId(taxonomyRaw) ? taxonomyRaw : null;
  const buyerType = asStr(p.buyer_type)?.slice(0, 40) ?? null;
  const industry = asStr(p.industry);
  const catalogType = asStr(p.catalog_type);
  const archetype = asStr(p.archetype);
  const confidence = asStr(p.confidence);
  const cycleRaw = p.cycle_days;
  const cycleDays =
    typeof cycleRaw === "number" && Number.isInteger(cycleRaw) && cycleRaw >= 1 && cycleRaw <= 1095
      ? cycleRaw
      : null;
  const result = {
    businessModel: "b2b" as InvestigateResult["businessModel"],
    vertical,
    taxonomyId,
    buyerType,
    cycleUnknown: p.cycle_unknown === true,
    industry: industry && VALID_INDUSTRIES.has(industry) ? industry : null,
    catalogType: catalogType && VALID_CATALOGS.has(catalogType) ? (catalogType as InvestigateResult["catalogType"]) : null,
    archetype: (archetype === "b2b_proyecto" ? "b2b_proyecto" : archetype === "b2b_recurrente" ? "b2b_recurrente" : null) as InvestigateResult["archetype"],
    cycleDays,
    companyRequired: true,
    confidence: confidence && VALID_CONF.has(confidence) ? (confidence as InvestigateResult["confidence"]) : "baja",
    understood: Array.isArray(p.understood) ? p.understood.filter((x): x is string => typeof x === "string").slice(0, 4) : [],
    questions: Array.isArray(p.questions) ? p.questions.filter((x): x is string => typeof x === "string").slice(0, 3) : [],
    sources: page ? { url: page.url, chars: page.text.length } : null,
    webText: page ? page.text.slice(0, 4000) : null,
  };
  log(`investigate llm model=${businessModel} vertical=${vertical} taxonomy=${taxonomyId} conf=${result.confidence} cycle=${cycleDays} buyer=${buyerType}`);
  return result;
}
