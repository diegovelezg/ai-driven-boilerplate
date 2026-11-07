import type { ReactNode } from "react";
import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/app-sidebar";
import { BackgroundStatus } from "@/components/background-status";
import { Toaster } from "@/components/ui/toast";
import { ChatDockProvider, DashboardShell } from "@/components/chat/chat-dock";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppTooltipProvider } from "@/components/ui/app-tooltip";
import { displayStoreName, listMyStores, getMyStoreRoles, type TenantStore } from "@/lib/tenant";
import { createServerSupabase } from "@/lib/supabase-server";

import { connection } from "next/server";

// La chrome del dashboard es siempre dinámica (auth + tenant por request),
// así que se permite la ruta bloqueante. Sin esto, el `connection()` de
// abajo hace fallar el prerender con `blocking-prerender-dynamic`
// (p. ej. Route "/screens").
export const instant = false;

// Chrome del dashboard: sidebar + header + toasts de background.
// Solo aplica a las rutas del grupo (dashboard); /login no lo hereda.
// Siempre dinámico: UI autenticada multiuser por tenant (cookies + membresía
// por request). `connection()` detiene el prerender aquí (Cache Components);
// sin esto, Next intenta prerenderizar "/" y falla con
// `blocking-prerender-current-time` (el cliente Supabase usa timers/Date).

// El layout carga tiendas (single-país: sin filtro por market);
// si falla, el header sigue funcionando.
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // Todo lo de abajo solo corre a request-time (ver nota arriba).
  await connection();
  let stores: TenantStore[] = [];
  try {
    stores = await listMyStores();
  } catch {
    // header degradado
  }
  // Email de la cuenta logueada en servidor: el UserMenu lo recibe como prop
  // para pintar el avatar + email en el primer paint, sin depender del fetch
  // cliente (que fallaba y dejaba el dropdown sin email).
  let userEmail: string | null = null;
  let userRoles: Record<string, import("@/lib/roles").MemberRole> = {};
  try {
    const supabase = await createServerSupabase();
    const { data } = await supabase.auth.getUser();
    userEmail = data.user?.email ?? null;
  } catch {
    userEmail = null;
  }
  try {
    const roles = await getMyStoreRoles();
    if (roles) userRoles = Object.fromEntries(roles.entries()) as Record<string, import("@/lib/roles").MemberRole>;
  } catch {
    userRoles = {};
  }
  return (
    <BackgroundStatus>
      <SidebarProvider defaultOpen={false}>
        <ChatDockProvider stores={stores.map((s) => ({ id: s.id, label: displayStoreName(s) }))}>
          <AppTooltipProvider>
            <AppSidebar />
            <SidebarInset>
              <AppHeader stores={stores} userEmail={userEmail} userRoles={userRoles} />
              <DashboardShell>{children}</DashboardShell>
            </SidebarInset>
            <Toaster limit={3} />
          </AppTooltipProvider>
        </ChatDockProvider>
      </SidebarProvider>
    </BackgroundStatus>
  );
}
