"use server";

import { revalidatePath } from "next/cache";
import { resolveStoreId } from "@/lib/customers-db";
import { readConnections } from "@/lib/store";
import {
  ARCHETYPES,
  upsertStoreProfile,
  type ArchetypeId,
  type BusinessModel,
  type CatalogType,
} from "@/lib/store-profiles";
import { isSupabaseConfigured } from "@/lib/supabase";

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

  try {
    await upsertStoreProfile({
      storeId,
      businessModel,
      industry: industryRaw || null,
      catalogType,
      repurchaseCycleDays: cycle,
      churnMultiplier: Math.round(mult * 100) / 100,
      archetype,
      archetypeSource,
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
