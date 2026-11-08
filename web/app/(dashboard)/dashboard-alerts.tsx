"use client";

import { useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Camera, CircleAlert, FileText, Package, RefreshCw, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { AlertKind, DashboardAlert } from "@/lib/dashboard";
import type { MemberRole } from "@/lib/roles";
import { OrdenDrawer } from "./orders/orden-drawer";

const ALERT_META: Record<AlertKind, { label: string; icon: LucideIcon; className: string }> = {
  sin_om: {
    label: "Sin OM",
    icon: FileText,
    className: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  },
  material: {
    label: "Material",
    icon: Package,
    className: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  sin_evidencia: {
    label: "Sin evidencia",
    icon: Camera,
    className: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  },
  termina_sin_relevo: {
    label: "Sin relevo",
    icon: RefreshCw,
    className: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  },
};

/** Fallback para kinds nuevos/corruptos (nunca crashea el muro). */
const FALLBACK_META = {
  label: "Alerta",
  icon: CircleAlert,
  className: "bg-muted text-muted-foreground",
} as const;

function metaFor(kind: AlertKind): { label: string; icon: LucideIcon; className: string } {
  return ALERT_META[kind] ?? FALLBACK_META;
}

/** Alertas de Hoy: abren el drawer de la orden sin salir de `/`.
 *  Deep-link compartible: `?alerta=<ioId>` (link, middle-click, back-button).
 *  Sincroniza con la URL vía `router.replace` (no agrega historial por clic). */
export function DashboardAlerts({
  alerts,
  myRole,
}: {
  alerts: DashboardAlert[];
  myRole: MemberRole | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // La URL manda (deep-link compartible + back/forward): sin estado local.
  const selectedId = searchParams.get("alerta")?.trim() || null;

  const open = useCallback(
    (ioId: string) => {
      router.replace(`?alerta=${encodeURIComponent(ioId)}`, { scroll: false });
    },
    [router],
  );

  const close = useCallback(() => {
    router.replace("/", { scroll: false });
  }, [router]);

  if (alerts.length === 0) {
    return (
      <p className="px-4 py-6 text-sm text-muted-foreground">
        Sin alertas. Todo lo firmado tiene OM, material aprobado y evidencia.
      </p>
    );
  }

  return (
    <>
      <ul className="divide-y divide-border">
        {alerts.map((a) => (
          <li key={`${a.kind}-${a.ioId}`}>
            <button
              type="button"
              onClick={() => open(a.ioId)}
              className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-muted/40"
            >
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant="secondary"
                    className={`gap-1 font-normal ${metaFor(a.kind).className}`}
                  >
                    {(() => {
                      const Icon = metaFor(a.kind).icon;
                      return <Icon aria-hidden />;
                    })()}
                    {metaFor(a.kind).label}
                  </Badge>
                  <span className="text-sm font-medium">{a.ioNumber}</span>
                  {a.brand && (
                    <span className="truncate text-xs text-muted-foreground">{a.brand}</span>
                  )}
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {a.detail}
                </span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {a.company ?? "—"}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {selectedId && (
        <OrdenDrawer orderId={selectedId} myRole={myRole} onClose={close} />
      )}
    </>
  );
}
