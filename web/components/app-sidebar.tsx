"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import {
  CircleHelp,
  Inbox,
  LayoutDashboard,
  MessagesSquare,
  Settings,
  TrendingUp,
  Users,
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
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import { useChatDock } from "@/components/chat/chat-dock";

const nav = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/finanzas", label: "Finanzas", icon: TrendingUp },
  { href: "/review", label: "Review Inbox", icon: Inbox, badge: "14" },
  { href: "/customers", label: "Customers", icon: Users },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/ayuda", label: "Ayuda", icon: CircleHelp },
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
  // El filtro global por país (?market=) y tienda (?store=) debe persistir
  // al navegar: los links del sidebar lo reinyectan en cada href.
  const suffix = (() => {
    const kept = new URLSearchParams();
    const store = sp.get("store");
    const market = sp.get("market");
    if (store) kept.set("store", store);
    if (market) kept.set("market", market);
    const qs = kept.toString();
    return qs ? `?${qs}` : "";
  })();
  const { dock, toggleChat } = useChatDock();
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              render={<Link href={`/${suffix}`} />}
              tooltip="AI Retention Engine"
            >
              <span className="flex size-6 items-center justify-center rounded bg-primary text-[11px] font-bold text-primary-foreground">
                AI
              </span>
              <span className="text-sm font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
                AI Retention Engine
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {nav.map((item) => {
                const active =
                  item.href === "/"
                    ? pathname === "/"
                    : pathname.startsWith(item.href);
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      render={<Link href={item.href} />}
                      isActive={active}
                      tooltip={
                        item.badge ? `${item.label} (${item.badge})` : item.label
                      }
                    >
                      <item.icon strokeWidth={1.75} />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                    {item.badge && (
                      <>
                        <SidebarMenuBadge>{item.badge}</SidebarMenuBadge>
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
        <SidebarSeparator />
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
