"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, Fragment, useEffect, useState } from "react";
import {
  Cat,
  Building2,
  CircleHelp,
  Contact,
  FileText,
  Inbox,
  LayoutDashboard,
  MessagesSquare,
  MonitorPlay,
  RotateCwClock,
  Settings,
  Tag,
  TrendingUp,
  Users,
} from "lucide-react";
import { ModeToggle } from "@/components/mode-toggle";
import { formatNumber } from "@/lib/format";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import { useChatDock } from "@/components/chat/chat-dock";

type NavItem = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  badgeKey?: "inbox";
};

type NavGroup = {
  label: string | null;
  items: NavItem[];
};

// Reorga: ritmo de uso, no alfabeto.
// - Principal: vista diaria.
// - Operación: donde se mueve plata (órdenes, recupero, inbox, finanzas).
// - Base comercial: maestros que cambian poco (inventario, empresas,
//   personas, marcas, clientes). Se configuran una vez, se consultan.
// - Sistema: config + ayuda.
const groups: NavGroup[] = [
  { label: null, items: [{ href: "/", label: "Dashboard", icon: LayoutDashboard }] },
  {
    label: "Operación",
    items: [
      { href: "/orders", label: "Órdenes", icon: FileText },
      { href: "/retention", label: "Retención", icon: RotateCwClock },
      { href: "/review", label: "Inbox", icon: Inbox, badgeKey: "inbox" },
      { href: "/finance", label: "Finanzas", icon: TrendingUp },
    ],
  },
  {
    label: "Base comercial",
    items: [
      { href: "/screens", label: "Inventario", icon: MonitorPlay },
      { href: "/companies", label: "Empresas", icon: Building2 },
      { href: "/contacts", label: "Contactos", icon: Contact },
      { href: "/brands", label: "Marcas", icon: Tag },
      { href: "/customers", label: "Customers", icon: Users },
    ],
  },
  {
    label: "Sistema",
    items: [
      { href: "/settings", label: "Settings", icon: Settings },
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
  // reinyectan en cada href. Single-país: sin ?market=.
  const suffix = (() => {
    const kept = new URLSearchParams();
    const store = sp.get("store");
    if (store) kept.set("store", store);
    const qs = kept.toString();
    return qs ? `?${qs}` : "";
  })();
  const { dock, toggleChat } = useChatDock();
  // Badge vivo del inbox con el mismo criterio que /review (no quemado):
  // borradores + leads + señales del tenant actual.
  const [inboxTotal, setInboxTotal] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/inbox-count${suffix ? `${suffix}` : ""}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive && j && typeof j.total === "number") setInboxTotal(j.total);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [suffix]);
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
                  const badge =
                    item.badgeKey === "inbox" && (inboxTotal ?? 0) > 0
                      ? formatNumber(inboxTotal)
                      : null;
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        render={<Link href={`${item.href}${suffix}`} />}
                        isActive={active}
                        tooltip={
                          badge ? `${item.label} (${badge})` : item.label
                        }
                      >
                        <item.icon strokeWidth={1.75} />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                      {badge && (
                        <>
                          <SidebarMenuBadge>{badge}</SidebarMenuBadge>
                          <span
                            aria-hidden="true"
                            className="pointer-events-none absolute top-1 right-1 hidden size-2 rounded-full bg-destructive ring-2 ring-sidebar group-data-[collapsible=icon]:block"
                          />
                        </>
                      )}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
            </SidebarGroup>
          </Fragment>
        ))}
        <SidebarSeparator className="mx-2 my-2" />
        <SidebarGroup>
          <SidebarGroupLabel>Asistente</SidebarGroupLabel>
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
