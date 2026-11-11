"use client";

import { Suspense } from "react";
import { usePathname } from "next/navigation";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { UserMenu } from "@/components/user-menu";
import { UsagePill } from "@/components/usage-pill";
import type { MemberRole } from "@/lib/roles";

const titles = [
  { href: "/inbox", label: "Inbox" },
  { href: "/occupancy", label: "Ocupación" },
  { href: "/orders", label: "Órdenes" },
  { href: "/screens", label: "Inventario" },
  { href: "/companies", label: "Empresas" },
  { href: "/contacts", label: "Contactos" },
  { href: "/brands", label: "Marcas" },
  { href: "/finance", label: "Finanzas" },
  { href: "/settings", label: "Configuración" },
  { href: "/help", label: "Ayuda" },
  { href: "/", label: "Hoy" },
];

export function AppHeader({
  stores = [],
  userEmail = null,
  userRoles = {},
}: {
  stores?: Array<{ id: string; name?: string | null }>;
  userEmail?: string | null;
  userRoles?: Record<string, MemberRole>;
}) {
  const pathname = usePathname();
  const title =
    titles.find((t) =>
      t.href === "/" ? pathname === "/" : pathname.startsWith(t.href),
    )?.label ?? "Hoy";

  return (
    <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 h-4" />
      <span className="text-sm font-medium">{title}</span>
      <span className="ms-auto flex items-center gap-2">
        <Suspense>
          <UsagePill stores={stores} />
          <UserMenu initialEmail={userEmail} stores={stores} initialRoles={userRoles} />
        </Suspense>
      </span>
    </header>
  );
}
