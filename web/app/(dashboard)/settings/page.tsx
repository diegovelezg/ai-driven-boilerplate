import { PageHeader } from "@/components/page-header";
import { readConnections, toSafeConnections } from "@/lib/store";
import { ARCHETYPES, getProfileSignals, getStoreProfile, suggestArchetype } from "@/lib/store-profiles";
import { HORIZON_BY_ARCHETYPE } from "@/lib/retention-model";
import { getPendingProposal } from "@/lib/profile-recalibrate/service";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { getMyStoreRole, requireMyStoreAccess } from "@/lib/tenant";
import { createServerSupabase } from "@/lib/supabase-server";
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
  searchParams?: Promise<{ tab?: string; store?: string }>;
}) {
  const sp = searchParams ? await searchParams : null;
  const requestedStore = sp?.store ?? null;
  // Tenant activo (?store= validado + membresía); legacy: JSON global.
  // Sin esto, con 2 tiendas o ?store= explícito la página mostraba/editaba
  // el tenant del JSON en vez del activo.
  let activeStoreId: string | null = null;
  if (isSupabaseConfigured()) {
    try {
      const { getMyActiveStore } = await import("@/lib/tenant");
      activeStoreId = (await getMyActiveStore(requestedStore).catch(() => null))?.active?.id ?? null;
    } catch {
      activeStoreId = null;
    }
  }
  const globalDefaults = await readConnections();
  const defaults = activeStoreId
    ? await readConnections(activeStoreId).catch(() => globalDefaults)
    : globalDefaults;
  // Seguridad: al cliente solo viajan booleanos has* (nunca los secretos en
  // plaintext por el Flight payload). Los valores reales solo viven en server.
  const safeDefaults = toSafeConnections(defaults);
  const resolvedId = activeStoreId;
  // Multiuser por tenant: la conexión legacy es global; sin membresía no se
  // muestra ni se edita nada de otro tenant.
  const storeId =
    resolvedId && (await requireMyStoreAccess(resolvedId).catch(() => null)) === false
      ? null
      : resolvedId;
  const accessDenied = Boolean(resolvedId && !storeId);
  const [profile, signals, proposal, secretsInDb, savedMap, membersData] = storeId
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
        import("@/lib/metadata-map")
          .then((m) => m.getMetadataMap(storeId))
          .catch(() => null),
        import("@/lib/members")
          .then((m) => m.listStoreMembers(storeId))
          .catch(() => []),
      ])
    : [null, null, null, false, null, []];
  const suggestion = suggestArchetype(signals);
  const contentReady = false;
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
          .select("customer_id,model,confidence,as_of")
          .eq("store_id", storeId)
          .order("as_of", { ascending: false })
          .order("model_version", { ascending: false })
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
      // v1+v2 conviven el día del deploy: un cliente, un voto (prefiere v2).
      const seenPhoto = new Set<string>();
      const photo = (maxAsOf ? rowsAll.filter((r) => String(r.as_of ?? "") === maxAsOf) : []).filter((r) => {
        const cid = String(r.customer_id ?? "");
        if (!cid || seenPhoto.has(cid)) return false;
        seenPhoto.add(cid);
        return true;
      });
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
  const rawTab = sp?.tab;
  const initialTab: SettingsTab =
    rawTab === "email" || rawTab === "negocio" || rawTab === "motor" || rawTab === "equipo" ? rawTab : "negocio";
  // Rol del usuario actual (para el tab Equipo) + su id (marca "tú").
  const myRole = storeId ? await getMyStoreRole(storeId).catch(() => null) : null;
  let myUserId: string | null = null;
  try {
    const supabase = await createServerSupabase();
    myUserId = (await supabase.auth.getUser()).data.user?.id ?? null;
  } catch {
    myUserId = null;
  }
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-6 md:p-8">
      <PageHeader
        eyebrow="Configuración"
        title="Settings"
        description="Calibra tu negocio y revisa lo que aprendió el motor."
      />
      {accessDenied ? (
        <p className="text-sm text-muted-foreground">
          Sin acceso a esta tienda. Pide a tu admin que te agregue en merchant_users.
        </p>
      ) : (
      <SettingsTabs
        key={initialTab}
        defaults={safeDefaults}
        secretsInDb={secretsInDb}
        storeId={storeId}
        contentReady={contentReady}
        contentMapped={savedMap !== null}
        contentKey={savedMap?.content ?? null}
        profile={profile}
        suggestion={suggestion}
        motor={motorCard}
        proposal={proposal}
        initialTab={initialTab}
        members={membersData ?? []}
        myRole={myRole}
        myUserId={myUserId}
      />
      )}
    </div>
  );
}
