import type { ReactNode } from "react";
import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/app-sidebar";
import { BackgroundStatus } from "@/components/background-status";
import { Toaster } from "@/components/ui/toast";
import { ChatDockProvider, DashboardShell } from "@/components/chat/chat-dock";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppTooltipProvider } from "@/components/ui/app-tooltip";
import { displayStoreName, listStores, type TenantStore } from "@/lib/tenant";
import { listStoreMarkets, pickPrimaryMarket, type TenantMarket } from "@/lib/markets";
import { createServerSupabase } from "@/lib/supabase-server";

// Chrome del dashboard: sidebar + header + toasts de background.
// Solo aplica a las rutas del grupo (dashboard); /login no lo hereda.
// El layout carga tiendas + markets para el filtro global por país (?market=);
// si falla, el header sigue funcionando sin selector.
// Nota CAP 50: es solo el selector UI. La resolución real del tenant/market
// (getActiveStore/resolveMarketScope en cada page) valida ?store=/?market=
// por ID directo, fuera de esta ventana.
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  let stores: TenantStore[] = [];
  let marketsByStore: Record<string, TenantMarket[]> = {};
  const primaryByStore: Record<string, string> = {};
  try {
    stores = await listStores();
    const entries = await Promise.all(
      stores.map(async (s) => [s.id, await listStoreMarkets(s.id)] as const),
    );
    marketsByStore = Object.fromEntries(entries);
    for (const s of stores) {
      const primary = pickPrimaryMarket(marketsByStore[s.id] ?? [], s.shop_currency);
      if (primary) primaryByStore[s.id] = primary.id;
    }
  } catch {
    // header degradado: sin selector de mercado
  }
  // Email de la cuenta logueada en servidor: el UserMenu lo recibe como prop
  // para pintar el avatar + email en el primer paint, sin depender del fetch
  // cliente (que fallaba y dejaba el dropdown sin email).
  let userEmail: string | null = null;
  try {
    const supabase = await createServerSupabase();
    const { data } = await supabase.auth.getUser();
    userEmail = data.user?.email ?? null;
  } catch {
    userEmail = null;
  }
  return (
    <BackgroundStatus>
      <SidebarProvider defaultOpen={false}>
        <ChatDockProvider stores={stores.map((s) => ({ id: s.id, label: displayStoreName(s) }))}>
          <AppTooltipProvider>
            <AppSidebar />
            <SidebarInset>
              <AppHeader stores={stores} marketsByStore={marketsByStore} primaryByStore={primaryByStore} userEmail={userEmail} />
              <DashboardShell>{children}</DashboardShell>
            </SidebarInset>
            <Toaster limit={3} />
          </AppTooltipProvider>
        </ChatDockProvider>
      </SidebarProvider>
    </BackgroundStatus>
  );
}
