import type { ReactNode } from "react";
import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/app-sidebar";
import { BackgroundStatus } from "@/components/background-status";
import { ChatDockProvider, DashboardShell } from "@/components/chat/chat-dock";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { displayStoreName, listStores, type TenantStore } from "@/lib/tenant";
import { listStoreMarkets, type TenantMarket } from "@/lib/markets";

// Chrome del dashboard: sidebar + header + cinta de background.
// Solo aplica a las rutas del grupo (dashboard); /login no lo hereda.
// El layout carga tiendas + markets para el filtro global por país (?market=);
// si falla, el header sigue funcionando sin selector.
// Nota CAP 50: es solo el selector UI. La resolución real del tenant/market
// (getActiveStore/resolveMarketScope en cada page) valida ?store=/?market=
// por ID directo, fuera de esta ventana.
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  let stores: TenantStore[] = [];
  let marketsByStore: Record<string, TenantMarket[]> = {};
  try {
    stores = await listStores();
    const entries = await Promise.all(
      stores.map(async (s) => [s.id, await listStoreMarkets(s.id)] as const),
    );
    marketsByStore = Object.fromEntries(entries);
  } catch {
    // header degradado: sin selector de mercado
  }
  return (
    <BackgroundStatus>
      <SidebarProvider defaultOpen={false}>
        <ChatDockProvider stores={stores.map((s) => ({ id: s.id, label: displayStoreName(s) }))}>
          <AppSidebar />
          <SidebarInset>
            <AppHeader stores={stores} marketsByStore={marketsByStore} />
            <DashboardShell>{children}</DashboardShell>
          </SidebarInset>
        </ChatDockProvider>
      </SidebarProvider>
    </BackgroundStatus>
  );
}
