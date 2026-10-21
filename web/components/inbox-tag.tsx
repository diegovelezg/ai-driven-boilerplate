"use client";

import { cn } from "cn";
import { AppTooltip } from "@/components/ui/app-tooltip";

/** Base visual idéntica a los pills de canal (whatsapp/email) del inbox. */
const PILL = "rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap";

export interface InboxTagMeta {
  label: string;
  className: string;
  tip: string;
}

const KIND_META: Record<string, InboxTagMeta> = {
  churn_risk: {
    label: "En riesgo",
    className: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
    tip: "En riesgo: dejó de comprar según su ciclo. Si no le escribes ahora, se pierde.",
  },
  vip_care: {
    label: "VIP",
    className: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    tip: "VIP: cliente leal de alto valor. Trato 1-a-1, reconoce su historial.",
  },
  winback: {
    label: "Winback",
    className: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    tip: "Winback: compró 1-2 veces y se frenó. Mensaje simple para traerlo de vuelta.",
  },
  nurture: {
    label: "Nurture",
    className: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
    tip: "Nurture: tenía hábito y se cortó. Nombra el quiebre y aporta una lectura útil.",
  },
};

const CHANNEL_META: Record<string, InboxTagMeta> = {
  whatsapp: {
    label: "WhatsApp",
    className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    tip: "WhatsApp: hay teléfono. Mensaje corto, se envía manual desde tu número.",
  },
  email: {
    label: "Email",
    className: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
    tip: "Email: sin teléfono a la vista. Lleva asunto, lo envía el dispatcher al aprobar.",
  },
};

const STATUS_META: Record<string, InboxTagMeta> = {
  open: {
    label: "abierta",
    className: "bg-muted text-muted-foreground",
    tip: "Abierta: detectada por el motor, aún sin priorizar.",
  },
  prioritized: {
    label: "priorizada",
    className: "bg-muted text-muted-foreground",
    tip: "Priorizada: el motor la ordenó, lista para redactar.",
  },
  actioned: {
    label: "gestionada",
    className: "bg-muted text-muted-foreground",
    tip: "Gestionada: ya tiene borrador en Review.",
  },
  pending_review: {
    label: "por aprobar",
    className: "bg-muted text-muted-foreground",
    tip: "Por aprobar: nada se envía sin tu visto bueno.",
  },
  approved: {
    label: "aprobada",
    className: "bg-muted text-muted-foreground",
    tip: "Aprobada: lista para enviar.",
  },
  dispatched: {
    label: "enviada",
    className: "bg-muted text-muted-foreground",
    tip: "Enviada: ya salió por su canal.",
  },
  dismissed: {
    label: "descartada",
    className: "bg-muted text-muted-foreground",
    tip: "Descartada: se esconde 30 días, puedes reabrirla con “contactar igual”.",
  },
};

function fallbackMeta(raw: string): InboxTagMeta {
  return {
    label: raw,
    className: "bg-muted text-muted-foreground",
    tip: `Estado “${raw}” sin descripción dedicada.`,
  };
}

/** Tag "Hoy": distingue lo generado hoy de la cola pendiente de días
 *  anteriores. Comparación por día calendario local (navegador). */
const TODAY_META: InboxTagMeta = {
  label: "Hoy",
  className: "bg-primary/10 text-primary",
  tip: "Generado hoy: entró hoy a la cola. Sin tag = pendiente de días anteriores.",
};

export function isToday(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

export function getKindMeta(kind: string | null | undefined): InboxTagMeta | null {
  if (!kind) return null;
  return KIND_META[kind] ?? fallbackMeta(kind);
}

export function getChannelMeta(channel: string | null | undefined): InboxTagMeta | null {
  if (!channel) return null;
  const key = channel.toLowerCase();
  return CHANNEL_META[key] ?? fallbackMeta(channel);
}

export function getStatusMeta(status: string | null | undefined): InboxTagMeta | null {
  if (!status) return null;
  return STATUS_META[status] ?? fallbackMeta(status);
}

function TagPill({ meta, className }: { meta: InboxTagMeta; className?: string }) {
  return (
    <AppTooltip tip={meta.tip}>
      <span className={cn(PILL, meta.className, className)}>{meta.label}</span>
    </AppTooltip>
  );
}

/** Tag de criterio (kind/objective): vip_care, churn_risk, winback, nurture. */
export function KindTag({ value, className }: { value: string | null | undefined; className?: string }) {
  const meta = getKindMeta(value);
  if (!meta) return null;
  return <TagPill meta={meta} className={className} />;
}

/** Tag de canal: whatsapp / email. Mismo pill que ya usaba el inbox. */
export function ChannelTag({ value, className }: { value: string | null | undefined; className?: string }) {
  const meta = getChannelMeta(value);
  if (!meta) return null;
  return <TagPill meta={meta} className={className} />;
}

/** Tag de estado de flujo: open, prioritized, pending_review, etc. */
export function StatusTag({ value, className }: { value: string | null | undefined; className?: string }) {
  const meta = getStatusMeta(value);
  if (!meta) return null;
  return <TagPill meta={meta} className={className} />;
}

/** Tag "Hoy": solo renderiza si el ISO es del día calendario actual.
 *  El resto (cola de días anteriores) queda sin tag, a propósito. */
export function TodayTag({ value, className }: { value: string | null | undefined; className?: string }) {
  if (!isToday(value)) return null;
  return <TagPill meta={TODAY_META} className={className} />;
}

/** Afinidad ICP 0..1 → 0-100 con semáforo propio (teal/cyan/orange: sin
 *  colisionar con kinds ni canales, ver test de unicidad de colores).
 *  Corte 50: por debajo no se guarda; 70+ alta, 85+ muy alta. */
export function getScoreMeta(value: number | null | undefined): InboxTagMeta | null {
  if (value == null || !Number.isFinite(value)) return null;
  const pct = Math.round(value * 100);
  if (pct >= 85) {
    return {
      label: `${pct}`,
      className: "bg-teal-500/10 text-teal-700 tabular-nums dark:text-teal-400",
      tip: `Afinidad muy alta (${pct}/100): encaja con tu cliente ideal en industria, tamaño y geografía.`,
    };
  }
  if (pct >= 70) {
    return {
      label: `${pct}`,
      className: "bg-cyan-500/10 text-cyan-700 tabular-nums dark:text-cyan-400",
      tip: `Afinidad alta (${pct}/100): buen encaje con tu cliente ideal, revísalo.`,
    };
  }
  return {
    label: `${pct}`,
    className: "bg-orange-500/10 text-orange-700 tabular-nums dark:text-orange-400",
    tip: `Afinidad moderada (${pct}/100): supera el corte (50) pero míralo con lupa.`,
  };
}

/** Tag de afinidad del prospector: número 0-100 con semáforo y tooltip. */
export function ScoreTag({ value, className }: { value: number | null | undefined; className?: string }) {
  const meta = getScoreMeta(value);
  if (!meta) return null;
  return <TagPill meta={meta} className={className} />;
}
