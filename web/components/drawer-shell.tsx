import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "cn";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";

/**
 * SSOT del layout de drawers (fichas laterales).
 * Estructura: header con avatar + título + badges, tab bar opcional y
 * contenido con scroll propio. `fill` (p.ej. chat) monta el contenido a
 * alto completo sin el contenedor padded; si no, padded estándar.
 * No usar Sheet/SheetContent ni replicar este layout por instancia.
 */
export interface DrawerTabDef {
  id: string;
  label: string;
  icon: LucideIcon;
}

export function DrawerShell({
  onClose,
  avatar,
  title,
  description,
  badges,
  tabs,
  tab,
  onTabChange,
  tabListLabel,
  fill,
  size,
  contentClassName,
  children,
}: {
  onClose: () => void;
  avatar: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  badges?: ReactNode;
  tabs?: DrawerTabDef[];
  tab?: string;
  onTabChange?: (id: string) => void;
  tabListLabel?: string;
  /** Contenido a alto completo (chat): sin contenedor padded. */
  fill?: boolean;
  /** Ancho del panel: default 640px, wide 920px (fichas densas). */
  size?: "default" | "wide";
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        className={cn(
          "data-[side=right]:w-full gap-0 overflow-hidden p-0",
          size === "wide"
            ? "data-[side=right]:sm:max-w-[min(920px,94vw)]"
            : "data-[side=right]:sm:max-w-[min(640px,94vw)]",
          contentClassName,
        )}
      >
        <div className="flex shrink-0 items-center gap-4 border-b border-border/60 bg-gradient-to-br from-primary/[0.05] via-background to-background px-4 py-6 sm:px-6">
          <div
            aria-hidden
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/15"
          >
            {avatar}
          </div>
          <div className="min-w-0 pr-8">
            <SheetTitle className="break-words text-xl font-semibold tracking-tight">{title}</SheetTitle>
            <SheetDescription className="mt-1 break-words text-sm leading-relaxed">{description ?? "—"}</SheetDescription>
            {badges && (
              <div className="mt-2 flex flex-wrap items-center gap-2">{badges}</div>
            )}
          </div>
        </div>

        {tabs && tabs.length > 0 && (
          <div className="shrink-0 px-4 py-4 sm:px-6">
            <div
              className="flex w-full gap-1 overflow-x-auto overflow-y-hidden rounded-xl bg-muted/60 p-1.5"
              role="tablist"
              aria-label={tabListLabel ?? "Detalle"}
            >
              {tabs.map((t) => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.id}
                    onClick={() => onTabChange?.(t.id)}
                    className={cn(
                      "flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      tab === t.id
                        ? "bg-background text-foreground shadow-sm ring-1 ring-border/60"
                        : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                    )}
                  >
                    <Icon className="size-4" aria-hidden />
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="scroll-fade-b [scrollbar-gutter:stable] flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
          {fill ? children : <div className="flex flex-col gap-6 px-4 pt-4 pb-6 sm:px-6">{children}</div>}
        </div>
      </SheetContent>
    </Sheet>
  );
}
