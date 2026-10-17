"use server";

import { revalidatePath } from "next/cache";
import { resolveStoreId } from "@/lib/customers-db";
import { readConnections } from "@/lib/store";
import {
  ARCHETYPES,
  getStoreProfile,
  resolveManualSlots,
  upsertStoreProfile,
  type ArchetypeId,
  type BusinessModel,
  type CatalogType,
} from "@/lib/store-profiles";
import { isSupabaseConfigured } from "@/lib/supabase";
import { investigateBusiness } from "@/lib/ai/investigate";
import { getProfileSignals } from "@/lib/store-profiles";
import { runProfiler } from "@/lib/profiling/pipeline";
import type { Synthesis } from "@/lib/profiling/synthesizer";
import { createLogger } from "@/lib/log";
import type { DescriptionInterpretation } from "@/lib/profile-interpreter";

const chatLog = createLogger("profiler");

/**
 * Perfil profundo con el set (investigator → sector + analyst →
 * synthesizer → critic). Lo corre el chat al confirmar: tarda ~1 min,
 * propone ciclo/buyer/arquetipo con evidencia y correcciones aplicadas.
 * Sin fallback silencioso: si falla, error honesto y se confirma lo del chat.
 */
export interface DeepProfileState {
  ok: boolean;
  message: string;
  synthesis?: Synthesis;
  criticVerdict?: "accept" | "reject";
  criticReasons?: string[];
}

export async function runProfilerAction(
  storeId: string,
  description: string,
): Promise<DeepProfileState> {
  try {
    const { synthesis, critic } = await runProfiler(storeId, description);
    return {
      ok: true,
      message: `Perfil profundo listo (critic: ${critic.verdict}).`,
      synthesis,
      criticVerdict: critic.verdict,
      criticReasons: critic.reasons,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "No pude generar el perfil profundo" };
  }
}

/**
 * Perfilador conversacional (slot-filling, no interrogatorio abierto).
 * Slots requeridos: business_model, vertical. Deseables: cycle_days,
 * buyer_type, catalog_type. Póliza: 1 pregunta por turno, máx 4 turnos de
 * usuario; la web y las señales de datos son evidencia (no se re-pregunta).
 * El humano siempre confirma la propuesta antes del paso 2.
 */
export interface ChatMsg {
  role: "user" | "agent";
  content: string;
}

export interface ProfileChatState {
  ok: boolean;
  reply: string;
  proposal?: DescriptionInterpretation & { sourceUrl: string | null; taxonomyId: string | null };
  /** true = slots requeridos completos = se puede confirmar (paso 2). */
  done: boolean;
  /** Slots requeridos aún vacíos (para deshabilitar el confirmar con motivo). */
  missing: string[];
}

/** El ciclo lo propone el set (sector+datos saben más que el olfato del
 *  merchant); el chat solo exige lo que únicamente el humano sabe.
 *  La única salida alternativa es el escape explícito "Omitir y usar datos". */
const REQUIRED_SLOTS = ["business_model", "vertical", "buyer_type"] as const;

/** Pregunta con propósito: cada slot desbloquea algo del motor. */
const SLOT_QUESTIONS: Array<{ slot: string; ask: string }> = [
  { slot: "business_model", ask: "¿Tus clientes son personas, empresas o ambos?" },
  { slot: "vertical", ask: "¿Cómo describirías tu rubro en una frase?" },
  { slot: "buyer_type", ask: "¿Quién te compra más: consumidor final, negocio pequeño o empresa grande?" },
  { slot: "catalog_type", ask: "¿Lo que vendes se recompra seguido, es por temporada o es una sola compra?" },
];

function slotValue(r: DescriptionInterpretation, slot: string): string | null {
  switch (slot) {
    case "business_model":
      return r.businessModel;
    case "vertical":
      return r.vertical;
    case "buyer_type":
      return r.buyerType;
    default:
      return null;
  }
}

function missingRequired(r: DescriptionInterpretation): string[] {
  return REQUIRED_SLOTS.filter((s) => slotValue(r, s) === null);
}

export async function chatProfileStepAction(
  history: ChatMsg[],
  input: string,
  storeId: string | null,
): Promise<ProfileChatState> {
  const userTexts = [...history.filter((m) => m.role === "user").map((m) => m.content), input]
    .map((t) => t.trim())
    .filter(Boolean);
  const combined = userTexts.join("\n").slice(0, 4000);
  const userTurns = userTexts.length;
  if (combined.length < 10) {
    return {
      ok: true,
      reply: "Cuéntame un poco más: ¿qué vendes y a quién se lo vendes?",
      done: false,
      missing: [...REQUIRED_SLOTS],
    };
  }
  // Señales de datos como contexto de fondo (n>=5 por muestra mínima).
  // El prompt dice que son apoyo, no material para recitar.
  let signalsCtx = "";
  if (storeId) {
    try {
      const s = await getProfileSignals(storeId);
      chatLog(`chat turn=${userTurns} signals=${s ? `${s.customers}c` : "none"}`);
      if (s && s.customers >= 5) {
        signalsCtx = `Datos de tu tienda (${s.customers} customers): ${Math.round(s.companyRate * 100)}% con empresa, ${Math.round(s.customDomainRate * 100)}% con dominio propio, ${Math.round(s.repeatRate * 100)}% con 2+ compras.`;
      }
    } catch {
      // sin señales: se sigue solo con lo dicho + la web
    }
  }
  let r;
  try {
    r = await investigateBusiness(combined, signalsCtx);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "No pude investigar ahora mismo.";
    // Al usuario, mensaje humano (el detalle técnico ya quedó en profiler.log).
    // Solo se muestra crudo lo accionable (falta de API key).
    const friendly = /Falta \S*API_KEY/.test(msg)
      ? msg
      : "Se me cortó la respuesta del proveedor, ¿me repites eso último?";
    return {
      ok: false,
      reply: friendly,
      done: false,
      missing: [...REQUIRED_SLOTS],
    };
  }
  // webText NO viaja al cliente (solo server: lo usa el synthesizer).
  const { webText: _webText, ...rest } = r;
  void _webText;
  const proposal = { ...rest, sourceUrl: r.sources?.url ?? null, taxonomyId: r.taxonomyId };
  const facts = r.understood.length > 0 ? `Entendido: ${r.understood.join(" · ")}.` : "";
  const webNote = r.sources ? ` (investigué ${r.sources.url})` : "";
  // Cierre del chat: solo cuando los 4 requeridos están agotados.
  // Ni confianza alta ni nº de turnos abren la puerta.
  const missing = missingRequired(r);
  const done = missing.length === 0;
  chatLog(`chat result missing=[${missing.join(",")}] conf=${r.confidence} done=${done}`);
  if (done) {
    return {
      ok: true,
      reply: `${facts}${webNote} Con esto ya puedo proponerte el perfil. Revísalo abajo y confírmalo.`.trim(),
      proposal,
      done: true,
      missing,
    };
  }
  // Una sola forma de responder, siempre: hechos (si hay) + una pregunta.
  // Sin web, la pregunta lleva el atajo de pegar la URL.
  const ask =
    SLOT_QUESTIONS.find((q) => q.slot === missing[0])?.ask ??
    r.questions[0] ??
    "¿Cada cuánto te vuelve a comprar un cliente?";
  const webHint = r.sources ? "" : " (si me pegas tu web, la investigo yo)";
  return {
    ok: true,
    reply: `${facts}${webNote} ${ask}${webHint}`.trim(),
    // Propuesta visible desde el 2º turno (transparencia), pero confirmar
    // exige done: sin slots agotados no hay paso 2.
    proposal: userTurns >= 2 ? proposal : undefined,
    done: false,
    missing,
  };
}

export interface ProfileSaveState {
  ok: boolean;
  message: string;
}

const MODELS: BusinessModel[] = ["b2c", "b2b", "hybrid"];
const ARCHETYPE_IDS = Object.keys(ARCHETYPES) as ArchetypeId[];

export async function saveTenantProfileAction(
  _prev: ProfileSaveState | null,
  formData: FormData,
): Promise<ProfileSaveState> {
  if (!isSupabaseConfigured()) {
    return { ok: false, message: "Sin Supabase en .env.local: perfil no guardado." };
  }
  const conn = await readConnections();
  if (!conn.medusaUrl) {
    return { ok: false, message: "Conecta Medusa primero: aún no hay store." };
  }
  const storeId = await resolveStoreId(conn.medusaUrl);
  if (!storeId) {
    return { ok: false, message: "Haz un sync primero (Guardar y conectar) para crear el store." };
  }

  const businessModel = String(formData.get("businessModel") ?? "b2c") as BusinessModel;
  const archetype = String(formData.get("archetype") ?? "b2c_consumible") as ArchetypeId;
  if (!MODELS.includes(businessModel)) return { ok: false, message: "Modelo inválido." };
  if (!ARCHETYPE_IDS.includes(archetype)) return { ok: false, message: "Arquetipo inválido." };

  const catalogRaw = String(formData.get("catalogType") ?? "").trim();
  const catalogType = (catalogRaw || null) as CatalogType | null;
  const industryRaw = String(formData.get("industry") ?? "").trim();
  const verticalRaw = String(formData.get("verticalDetected") ?? "").trim().slice(0, 80) || null;
  const taxonomyRaw = String(formData.get("taxonomyId") ?? "").trim() || null;
  const buyerRaw = String(formData.get("buyerType") ?? "").trim().slice(0, 80) || null;
  const cycleRaw = String(formData.get("repurchaseCycleDays") ?? "").trim();
  const multRaw = String(formData.get("churnMultiplier") ?? "").trim();
  const cycle = cycleRaw ? Number(cycleRaw) : null;
  const mult = multRaw ? Number(multRaw) : ARCHETYPES[archetype].defaultMultiplier;
  if (cycle !== null && (!Number.isInteger(cycle) || cycle < 1 || cycle > 1095)) {
    return { ok: false, message: "Ciclo de recompra: 1–1095 días o vacío (auto)." };
  }
  if (!Number.isFinite(mult) || mult < 1 || mult > 5) {
    return { ok: false, message: "Multiplicador de churn: 1.0–5.0." };
  }
  const source = String(formData.get("archetypeSource") ?? "manual");
  const archetypeSource = source === "sugerido" ? "sugerido" : "manual";
  const description = String(formData.get("description") ?? "").trim() || null;
  const confRaw = String(formData.get("interpretationConfidence") ?? "").trim();
  const interpretationConfidence =
    confRaw === "alta" || confRaw === "media" || confRaw === "baja" ? confRaw : null;

  // Slots que el merchant fijó a mano: el vigilante (#6) nunca propone
  // cambiarlos. No basta la fuente: un guardado "sugerido" conserva la
  // protección de los slots manuales previos que no cambiaron de valor.
  const existing = await getStoreProfile(storeId).catch(() => null);
  const manualSlots = resolveManualSlots({
    archetypeSource,
    archetype,
    cycleDays: cycle,
    taxonomyId: taxonomyRaw,
    buyerType: buyerRaw,
    existing,
  });

  try {
    await upsertStoreProfile({
      storeId,
      businessModel,
      verticalDetected: verticalRaw,
      taxonomyId: taxonomyRaw,
      buyerType: buyerRaw,
      industry: industryRaw || null,
      catalogType,
      repurchaseCycleDays: cycle,
      churnMultiplier: Math.round(mult * 100) / 100,
      archetype,
      archetypeSource,
      manualSlots,
      companyRequired: formData.get("companyRequired") === "on",
      description,
      interpretationConfidence,
      notes: String(formData.get("notes") ?? "").trim() || null,
    });
    revalidatePath("/settings");
    return { ok: true, message: `Perfil guardado: ${ARCHETYPES[archetype].label}.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error al guardar" };
  }
}
