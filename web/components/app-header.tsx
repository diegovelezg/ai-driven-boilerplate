"use client";

import { usePathname } from "next/navigation";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";

const titles = [
  { href: "/review", label: "Review Inbox" },
  { href: "/chat", label: "Chat" },
  { href: "/customers", label: "Customers" },
  { href: "/campaigns", label: "Campaigns" },
  { href: "/settings", label: "Settings" },
  { href: "/", label: "Dashboard" },
];

export function AppHeader() {
  const pathname = usePathname();
  const title =
    titles.find((t) =>
      t.href === "/" ? pathname === "/" : pathname.startsWith(t.href),
    )?.label ?? "Dashboard";

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 h-4" />
      <span className="text-sm font-medium">{title}</span>
    </header>
  );
}
