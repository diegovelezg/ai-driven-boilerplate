import { PageHeader } from "@/components/page-header";
import { resolveStoreId } from "@/lib/customers-db";
import { readConnections } from "@/lib/store";
import { ARCHETYPES, getProfileSignals, getStoreProfile, suggestArchetype } from "@/lib/store-profiles";
import { HORIZON_BY_ARCHETYPE } from "@/lib/retention-model";
import { getPendingProposal } from "@/lib/profile-recalibrate/service";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { SettingsTabs, type SettingsTab } from "./settings-tabs";

export const instant = false;

/** Mediana de gaps entre sesiones (≥1d) sobre una muestra de órdenes. */
function observedMedianGap(
  orders: Array<{ customer_id: string; at: number }>,
): number | null {
  const DAY = 86_400_000;
  const byCust = new Map<string, number[]>();
  for (const o of orders) {
    if (!byCust.has(o.customer_id)) byCust.set(o.customer_id, []);
    byCust.get(o.customer_id)!.push(o.at);
  }
  const gaps: number[] = [];
  for (const times of byCust.values()) {
    times.sort((a, b) => a - b);
    const sessions: number[] = [times[0]];
    for (let i = 1; i < times.length; i += 1) {
      if (times[i] - sessions[sessions.length - 1] >= DAY) sessions.push(times[i]);
    }
    for (let i = 1; i < sessions.length; i += 1) {
      gaps.push((sessions[i] - sessions[i - 1]) / DAY);
    }
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const med = gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return Math.round(med);
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams?: Promise<{ tab?: string }>;
}) {
  const defaults = await readConnections();
  const storeId =
    isSupabaseConfigured() && defaults.medusaUrl
      ? await resolveStoreId(defaults.medusaUrl).catch(() => null)
      : null;
  const [profile, signals, proposal, secretsInDb] = storeId
    ? await Promise.all([
        getStoreProfile(storeId).catch(() => null),
        getProfileSignals(storeId).catch(() => null),
        getPendingProposal(storeId).catch(() => null),
        import("@/lib/secrets-crypto")
          .then(async (c) => {
            if (!c.isEncryptionConfigured()) return false;
            const { getSupabase } = await import("@/lib/supabase");
            const { data } = await getSupabase()
              .from("store_secrets")
              .select("key_name")
              .eq("store_id", storeId)
              .limit(1);
            return (data?.length ?? 0) > 0;
          })
          .catch(() => false),
      ])
    : [null, null, null, false];
  const suggestion = suggestArchetype(signals);
  // Qué aprendió el motor (solo lectura de predicciones + órdenes, sin priors ni grillas).
  let motorCard: {
    declarado: number | null;
    observado: number | null;
    archetypeLabel: string;
    h: number;
    firmes: number;
    total: number;
  } | null = null;
  if (storeId && profile) {
    try {
      const db = getSupabase();
      const [{ data: pr }, { data: or }] = await Promise.all([
        db
          .from("customer_predictions")
          .select("model,confidence,as_of")
          .eq("store_id", storeId)
          .order("as_of", { ascending: false })
          .limit(5000),
        db
          .from("orders")
          .select("customer_id,placed_at")
          .eq("store_id", storeId)
          .order("placed_at", { ascending: true })
          .limit(3000),
      ]);
      const rowsAll = (pr ?? []) as Array<Record<string, unknown>>;
      const maxAsOf = rowsAll.length > 0 ? String(rowsAll[0].as_of ?? "") : null;
      const photo = maxAsOf ? rowsAll.filter((r) => String(r.as_of ?? "") === maxAsOf) : [];
      const firmes = photo.filter((r) => String(r.confidence ?? "") !== "baja").length;
      const times = ((or ?? []) as Array<Record<string, unknown>>)
        .map((r) => ({
          customer_id: String(r.customer_id ?? ""),
          at: r.placed_at ? Date.parse(r.placed_at as string) : NaN,
        }))
        .filter((o) => o.customer_id && !Number.isNaN(o.at));
      motorCard = {
        declarado: profile.repurchaseCycleDays,
        observado: observedMedianGap(times),
        archetypeLabel: ARCHETYPES[profile.archetype]?.label ?? profile.archetype,
        h: HORIZON_BY_ARCHETYPE[profile.archetype] ?? 60,
        firmes,
        total: photo.length,
      };
    } catch {
      motorCard = null;
    }
  }
  const sp = searchParams ? await searchParams : null;
  const rawTab = sp?.tab;
  const initialTab: SettingsTab =
    rawTab === "email" || rawTab === "negocio" || rawTab === "motor" ? rawTab : "tienda";
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-6 md:p-8">
      <PageHeader
        eyebrow="Configuración"
        title="Settings"
        description="Conecta tu tienda, calibra tu negocio y revisa lo que aprendió el motor."
      />
      <SettingsTabs
        key={initialTab}
        defaults={defaults}
        secretsInDb={secretsInDb}
        storeId={storeId}
        profile={profile}
        suggestion={suggestion}
        motor={motorCard}
        proposal={proposal}
        initialTab={initialTab}
      />
    </div>
  );
}
