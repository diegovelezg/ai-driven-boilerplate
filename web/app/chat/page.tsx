import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { resolveStoreId } from "@/lib/customers-db";
import { readConnections } from "@/lib/store";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { AGENT_FOCOS, type AgentFoco } from "@/app/api/chat/route";
import { ChatView } from "./chat-view";

export const instant = false;

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ store?: string; foco?: string }>;
}) {
  if (!isSupabaseConfigured()) {
    return (
      <div className="flex w-full flex-col gap-6 p-6">
        <h1 className="text-lg font-semibold tracking-tight">Pregúntale a tu equipo</h1>
        <Card>
          <CardContent className="p-4 text-[13px] text-muted-foreground">
            Supabase no configurado (`supabase start` + `web/.env.local`).
          </CardContent>
        </Card>
      </div>
    );
  }

  const sp = await searchParams;
  const foco: AgentFoco = (AGENT_FOCOS as readonly string[]).includes(sp.foco ?? "")
    ? (sp.foco as AgentFoco)
    : "general";

  const db = getSupabase();
  const { data: storesData } = await db
    .from("stores")
    .select("id,name,shop_url")
    .order("created_at", { ascending: true })
    .limit(50);
  const stores = ((storesData ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    name: (r.name as string | null) ?? null,
    shop_url: String(r.shop_url ?? ""),
  }));
  if (stores.length === 0) {
    return (
      <div className="flex w-full flex-col gap-6 p-6">
        <h1 className="text-lg font-semibold tracking-tight">Pregúntale a tu equipo</h1>
        <Card>
          <CardContent className="flex items-center justify-between p-4">
            <p className="text-[13px] text-muted-foreground">
              Conecta tu tienda para empezar a preguntar.
            </p>
            <Button render={<Link href="/settings" />} nativeButton={false} variant="outline" size="sm">
              Ir a Settings
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const conn = await readConnections();
  let activeId = sp.store ?? null;
  if (!activeId || !stores.some((s) => s.id === activeId)) {
    const viaConn = conn.medusaUrl ? await resolveStoreId(conn.medusaUrl).catch(() => null) : null;
    activeId = (viaConn && stores.some((s) => s.id === viaConn) ? viaConn : null) ?? stores[0].id;
  }
  const active = stores.find((s) => s.id === activeId) ?? stores[0];

  return <ChatView storeId={active.id} storeName={active.name ?? active.shop_url} initialFoco={foco} />;
}
