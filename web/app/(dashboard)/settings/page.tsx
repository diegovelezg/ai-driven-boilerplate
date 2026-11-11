import { PageHeader } from "@/components/page-header";
import { connection } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getMyStoreRole, requireMyStoreAccess } from "@/lib/tenant";
import { createServerSupabase } from "@/lib/supabase-server";
import { TeamPanel } from "./team-panel";

export const instant = false;

// Settings simplificado: solo Equipo. Negocio eliminado (el perfil del
// tenant lo escribe el profiler; nadie lo consumía en UI) y Email oculto
// por ahora (el sender no tiene llamadas; se conserva
// components/settings-form.tsx para reactivarlo).
export default async function SettingsPage({
  searchParams,
}: {
  searchParams?: Promise<{ store?: string }>;
}) {
  await connection();
  const sp = searchParams ? await searchParams : null;
  const requestedStore = sp?.store ?? null;
  let activeStoreId: string | null = null;
  if (isSupabaseConfigured()) {
    try {
      const { getMyActiveStore } = await import("@/lib/tenant");
      activeStoreId = (await getMyActiveStore(requestedStore).catch(() => null))?.active?.id ?? null;
    } catch {
      activeStoreId = null;
    }
  }
  const resolvedId = activeStoreId;
  const storeId =
    resolvedId && (await requireMyStoreAccess(resolvedId).catch(() => null)) === false
      ? null
      : resolvedId;
  const accessDenied = Boolean(resolvedId && !storeId);
  const membersData = storeId
    ? await import("@/lib/members")
        .then((m) => m.listStoreMembers(storeId))
        .catch(() => [])
    : [];
  const myRole = storeId ? await getMyStoreRole(storeId).catch(() => null) : null;
  let myUserId: string | null = null;
  try {
    const supabase = await createServerSupabase();
    myUserId = (await supabase.auth.getUser()).data.user?.id ?? null;
  } catch {
    myUserId = null;
  }
  return (
    <div className="page-shell max-w-[1200px]">
      <PageHeader
        eyebrow="Configuración"
        title="Equipo"
        description="Quién puede entrar a esta tienda y qué puede hacer cada persona."
      />
      {accessDenied ? (
        <p className="text-sm text-muted-foreground">
          Sin acceso a esta tienda. Pide a un administrador que te dé acceso.
        </p>
      ) : (
        <TeamPanel
          members={membersData ?? []}
          myRole={myRole}
          myUserId={myUserId}
          storeId={storeId}
        />
      )}
    </div>
  );
}
