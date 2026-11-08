// SSOT de mapas crudos → Badge por dominio (issue #8 P2).
// Antes cada badge pintaba el crudo de la DB (paid/overdue, paused/draft,
// '' → "Borrador" inventado, b2c → "B2B"). Un solo mapa por dominio;
// los componentes *-badges lo consumen y profile-chat importa MODEL_LABEL.
import type { BusinessModel } from "@/lib/profile-interpreter";

export type BadgeVariant = "default" | "secondary" | "success" | "destructive" | "outline";

/** Modelo de negocio → etiqueta. b2c vende a personas, no a empresas. */
export const MODEL_LABEL: Record<BusinessModel, string> = {
  b2c: "B2C · personas",
  b2b: "B2B · empresas",
  hybrid: "Mixto",
};

/** Factura individual: misma gramática que el cobro (billing-status). */
export function invoiceBadgeDisplay(status: string | null | undefined): {
  variant: BadgeVariant;
  label: string;
} {
  const s = String(status ?? "").trim().toLowerCase();
  if (s === "paid") return { variant: "success", label: "Pagada" };
  if (s === "overdue") return { variant: "destructive", label: "Vencida" };
  if (s === "issued") return { variant: "outline", label: "Emitida" };
  if (s === "cancelled") return { variant: "destructive", label: "Anulada" };
  if (s === "draft") return { variant: "secondary", label: "Borrador" };
  if (!s) return { variant: "secondary", label: "—" };
  return { variant: "secondary", label: s };
}

/** Estado de IO: ''/null = sin dato (—), nunca "Borrador" inventado. */
export function companyIoBadgeDisplay(status: string | null | undefined): {
  stage: "firmada" | "cancelada";
  isDraft: boolean;
  isEmpty: boolean;
} {
  const s = String(status ?? "").trim().toLowerCase();
  if (!s) return { stage: "firmada", isDraft: false, isEmpty: true };
  if (s === "cancelled") return { stage: "cancelada", isDraft: false, isEmpty: false };
  if (s === "signed") return { stage: "firmada", isDraft: false, isEmpty: false };
  return { stage: "firmada", isDraft: true, isEmpty: false };
}

/** Estado de campaña: paused/draft tienen etiqueta propia, no crudo. */
export function campaignBadgeDisplay(status: string | null | undefined): {
  variant: BadgeVariant;
  label: string;
  title: string;
} {
  const s = String(status ?? "").trim().toLowerCase();
  if (s === "active") return { variant: "default", label: "Activa", title: "Campaña en curso" };
  if (s === "completed") return { variant: "secondary", label: "Completada", title: "Campaña terminada" };
  if (s === "paused") return { variant: "outline", label: "Pausada", title: "Campaña en pausa" };
  if (s === "draft" || s === "") return { variant: "secondary", label: s === "" ? "—" : "Borrador", title: "Campaña en borrador" };
  return { variant: "secondary", label: s || "—", title: "Estado de campaña" };
}
