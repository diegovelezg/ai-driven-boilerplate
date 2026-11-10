"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, Fragment, useEffect, useState } from "react";
import {
  Cat,
  Building2,
  CalendarDays,
  CircleHelp,
  Contact,
  FileText,
  Inbox,
  LayoutDashboard,
  MessagesSquare,
  MonitorPlay,
  Settings,
  Tag,
  TrendingUp,
} from "lucide-react";
import { ModeToggle } from "@/components/mode-toggle";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import { useChatDock } from "@/components/chat/chat-dock";

type NavItem = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
};

type NavGroup = {
  label: string | null;
  items: NavItem[];
};

// Reorga Fase 2 (DOOH): operación = órdenes + finanzas; base comercial =
// inventario, empresas, personas, marcas. Sin motor de retención: no hay
// Retención, Inbox ni Customers ecommerce. Finanzas sí se conserva.
const groups: NavGroup[] = [
  { label: null, items: [
    { href: "/", label: "Hoy", icon: LayoutDashboard },
    { href: "/inbox", label: "Inbox", icon: Inbox },
  ] },
  {
    label: "Operación",
    items: [
      { href: "/orders", label: "Órdenes", icon: FileText },
      { href: "/finance", label: "Finanzas", icon: TrendingUp },
      { href: "/occupancy", label: "Ocupación", icon: CalendarDays },
    ],
  },
  {
    label: "Base comercial",
    items: [
      { href: "/screens", label: "Inventario", icon: MonitorPlay },
      { href: "/companies", label: "Empresas", icon: Building2 },
      { href: "/contacts", label: "Contactos", icon: Contact },
      { href: "/brands", label: "Marcas", icon: Tag },
    ],
  },
  {
    label: "Sistema",
    items: [
      { href: "/settings", label: "Configuración", icon: Settings },
      { href: "/help", label: "Ayuda", icon: CircleHelp },
    ],
  },
];

export function AppSidebar() {
  return (
    <Suspense>
      <AppSidebarNav />
    </Suspense>
  );
}

function AppSidebarNav() {
  const pathname = usePathname();
  const sp = useSearchParams();
  // La tienda (?store=) persiste al navegar: los links del sidebar la
  // reinyectan en cada href.
  const suffix = (() => {
    const kept = new URLSearchParams();
    const store = sp.get("store");
    if (store) kept.set("store", store);
    const qs = kept.toString();
    return qs ? `?${qs}` : "";
  })();
  // Badge del Inbox: avisos activos (no descartados). Se recarga al navegar
  // y cuando el inbox avisa mutación (`inbox:update` tras descartar/restaurar).
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const { getUnreadWallCountAction } = await import("@/lib/insights-actions");
        const n = await getUnreadWallCountAction();
        if (alive) setUnread(n);
      } catch {
        // Sin badge antes que sin página.
      }
    };
    void load();
    const onUpdate = () => void load();
    window.addEventListener("inbox:update", onUpdate);
    return () => {
      alive = false;
      window.removeEventListener("inbox:update", onUpdate);
    };
  }, [pathname, suffix]);
  const { dock, toggleChat } = useChatDock();
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              render={<Link href={`/${suffix}`} />}
              tooltip="MEOW"
              className="group-data-[collapsible=icon]:justify-center"
            >
              <span className="flex size-6 items-center justify-center rounded bg-primary text-primary-foreground">
                <Cat className="size-4" strokeWidth={2} />
              </span>
              <span className="text-sm font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
                MEOW
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="gap-1 py-2">
        {groups.map((group, i) => (
          <Fragment key={group.label ?? "principal"}>
            {i > 0 && <SidebarSeparator className="mx-2 my-2" />}
            <SidebarGroup className="px-2 py-1.5">
              {group.label && (
                <SidebarGroupLabel className="px-2 pb-1.5 tracking-wide uppercase">
                  {group.label}
                </SidebarGroupLabel>
              )}
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const active =
                    item.href === "/"
                      ? pathname === "/"
                      : pathname.startsWith(item.href);
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        render={<Link href={`${item.href}${suffix}`} />}
                        isActive={active}
                        tooltip={item.label}
                      >
                        <item.icon strokeWidth={1.75} />
                        <span>{item.label}</span>
                        {item.href === "/inbox" && unread > 0 && (
                          <>
                            <span
                              className="ms-auto flex min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground tabular-nums group-data-[collapsible=icon]:hidden"
                              aria-label={`${unread} avisos sin leer`}
                              role="status"
                            >
                              {unread > 9 ? "9+" : unread}
                            </span>
                            {/* Modo icono colapsado: el pill se oculta, queda el punto. */}
                            <span
                              aria-hidden
                              className="hidden size-2 shrink-0 rounded-full bg-primary group-data-[collapsible=icon]:block"
                            />
                          </>
                        )}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
            </SidebarGroup>
          </Fragment>
        ))}
        <SidebarSeparator className="mx-2 my-2" />
        <SidebarGroup className="px-2 py-1.5">
          <SidebarGroupLabel className="px-2 pb-1.5 tracking-wide uppercase">
            Asistente
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                {/* No navega: abre el dock y la vista actual queda a la derecha.
                    Activo = dock abierto. */}
                <SidebarMenuButton
                  onClick={toggleChat}
                  isActive={dock !== null}
                  tooltip="Chat"
                >
                  <MessagesSquare strokeWidth={1.75} />
                  <span>Chat</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div className="flex items-center justify-between px-1 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-2">
          <span className="truncate text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
            diegovelezg@gmail.com
          </span>
          <ModeToggle />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
