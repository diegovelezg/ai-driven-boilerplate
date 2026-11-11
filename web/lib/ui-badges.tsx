// SSOT CENTRAL de badges (único lugar donde se define color/semántica).
// Regla: ningún componente ni vista hardcodea `variant="..."` con lógica
// propia. Todo consumo pasa por un `*Display()` de este archivo + un
// componente en `components/*-badges.tsx` o `components/badges.tsx`.
//
// Gramática (7 variantes en `components/ui/badge.tsx`):
// - default (azul): protagonista en curso / selección / designación
//   (Al aire, Activa, Parcial, Principal, ≤30d).
// - success (verde): logro terminal positivo
//   (Firmada, Cerrada, Pagado, Aprobado, En pauta).
// - warning (ámbar): requiere acción, no es error
//   (Materiales, Por certificar, Sin facturar, Pendiente, Pausada, Hold).
// - info (celeste): en curso neutro / transitorio
//   (Facturado, Emitida, Confirmada, Generando…).
// - destructive (rojo): terminal negativo accionable
//   (Cancelada, Vencido/Vencida).
// - secondary (gris): muerto / ausente / quieto
//   (Borrador, — sin dato, Archivada/o, Inactiva, Sin pauta, Anulada).
// - outline (borde): identidad / atributo, NO es estado
//   (Kind, Rol, Video/Foto, Fuente, Tag, Completada quieta).
import type { BusinessModel } from "@/lib/profile-interpreter";
import { BILLING_LABELS, type BillingStatusKey } from "@/lib/billing-status";
import { ORDER_STAGE_LABELS, type OrderStageKey } from "@/lib/order-stage";

export type BadgeVariant =
  | "default"
  | "secondary"
  | "success"
  | "destructive"
  | "outline"
  | "warning"
  | "info";

export interface BadgeDisplay {
  variant: BadgeVariant;
  label: string;
  title?: string;
}

/** Modelo de negocio → etiqueta. b2c vende a personas, no a empresas. */
export const MODEL_LABEL: Record<BusinessModel, string> = {
  b2c: "B2C · personas",
  b2b: "B2B · empresas",
  hybrid: "Mixto",
};

/* ── Carril operativo: etapa de orden ─────────────────────────── */

export function orderStageDisplay(stage: OrderStageKey, isDraft: boolean): BadgeDisplay & { title: string } {
  if (stage === "cancelada")
    return { variant: "destructive", label: "Cancelada", title: "Orden cancelada" };
  if (stage === "cerrada")
    return { variant: "success", label: "Cerrada", title: "Ciclo operativo completo" };
  if (stage === "firmada") {
    return isDraft
      ? { variant: "secondary", label: "Borrador", title: "Borrador: aún no la firma el cliente" }
      : { variant: "success", label: "Firmada", title: "Firmada por el cliente" };
  }
  if (stage === "programada")
    return { variant: "info", label: "Programada", title: "Preparada; fuera del período de emisión actual" };
  if (stage === "atrasada")
    return { variant: "destructive", label: "Salida atrasada", title: "Inicio alcanzado con autorización o materiales pendientes" };
  if (stage === "al_aire")
    return { variant: "default", label: "Al aire", title: "En período de emisión según fechas contratadas; no confirma reproducción" };
  return {
    variant: "warning",
    label: ORDER_STAGE_LABELS[stage],
    title: "Etapa operativa: requiere acción",
  };
}

/* ── Carril administrativo: cobro ─────────────────────────────── */

export function orderBillingDisplay(status: BillingStatusKey): BadgeDisplay {
  if (status === "pagado") return { variant: "success", label: BILLING_LABELS[status] };
  if (status === "vencido") return { variant: "destructive", label: BILLING_LABELS[status] };
  if (status === "parcial") return { variant: "default", label: BILLING_LABELS[status] };
  if (status === "facturado") return { variant: "info", label: BILLING_LABELS[status] };
  return { variant: "warning", label: BILLING_LABELS[status] };
}

/** Factura individual: misma gramática que el cobro. */
export function invoiceBadgeDisplay(status: string | null | undefined): BadgeDisplay {
  const s = String(status ?? "").trim().toLowerCase();
  if (s === "partial") return { variant: "default", label: "Parcial" };
  if (s === "paid") return { variant: "success", label: "Pagada" };
  if (s === "overdue") return { variant: "destructive", label: "Vencida" };
  if (s === "issued") return { variant: "info", label: "Emitida" };
  // Anulada es terminal pero quieta (no exige cobro): gris, no rojo.
  if (s === "cancelled") return { variant: "secondary", label: "Anulada" };
  if (s === "draft") return { variant: "secondary", label: "Borrador" };
  if (!s) return { variant: "secondary", label: "—" };
  return { variant: "secondary", label: s };
}

/** Aprobación de material: verde o ámbar, sin grises (pendiente = acción). */
export function approvalBadgeDisplay(approved: boolean): BadgeDisplay & { title: string } {
  return approved
    ? { variant: "success", label: "Aprobado", title: "Aprobado al adjuntar" }
    : { variant: "warning", label: "Pendiente", title: "Material pendiente de aprobación" };
}

/* ── Empresas: IO + campaña ───────────────────────────────────── */

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

/** Estado de campaña: activa en curso, pausada pide acción, completada quieta. */
export function campaignBadgeDisplay(status: string | null | undefined): BadgeDisplay & { title: string } {
  const s = String(status ?? "").trim().toLowerCase();
  if (s === "active") return { variant: "default", label: "Activa", title: "Campaña en curso" };
  if (s === "completed")
    return { variant: "outline", label: "Completada", title: "Campaña terminada" };
  if (s === "paused") return { variant: "warning", label: "Pausada", title: "Campaña en pausa" };
  if (s === "draft" || s === "")
    return { variant: "secondary", label: s === "" ? "—" : "Borrador", title: "Campaña en borrador" };
  return { variant: "secondary", label: s || "—", title: "Estado de campaña" };
}

/* ── Genéricos: entidad / identidad / transitorios ──────────────
 * Todo `variant="secondary"` inline disperso se reemplaza por uno de estos.
 * Ninguna vista define variantes por su cuenta.
 */

/** Archivo (contacto/empresa): muerto, gris. `fem` = Archivada vs Archivado. */
export function archivedBadgeDisplay(fem = false): BadgeDisplay & { title: string } {
  return {
    variant: "secondary",
    label: fem ? "Archivada" : "Archivado",
    title: fem ? "Empresa archivada" : "Contacto archivado",
  };
}

/** Pantalla activa/inactiva. */
export function screenActiveDisplay(isActive: boolean): BadgeDisplay & { title: string } {
  return isActive
    ? { variant: "success", label: "Activa", title: "Pantalla activa" }
    : { variant: "secondary", label: "Inactiva", title: "Pantalla inactiva" };
}

/** Marca con/sin pauta vigente. */
export function brandPautaDisplay(active: boolean): BadgeDisplay & { title: string } {
  return active
    ? { variant: "success", label: "En pauta", title: "Marca con pauta vigente" }
    : { variant: "secondary", label: "Sin pauta", title: "Marca sin pauta vigente" };
}

/** Identidad / atributo (kind, rol, medio, fuente, tag, tipo material):
 *  borde neutro, nunca compite con el semáforo. */
export function attributeDisplay(label: string, title: string): BadgeDisplay & { title: string } {
  return { variant: "outline", label, title };
}

/** Designación principal: azul (no es éxito, es marca). */
export function principalBadgeDisplay(): BadgeDisplay & { title: string } {
  return { variant: "default", label: "Principal", title: "Contacto principal" };
}

/** Ocupación de pantalla: reserva futura comprometida ≠ inerte. */
export function occupancyBadgeDisplay(status: string, source: "order" | "booking"): BadgeDisplay {
  const s = String(status ?? "").trim().toLowerCase();
  if (s === "cancelled" || s === "cancelada") return { variant: "destructive", label: "Cancelada" };
  if (source === "booking") {
    if (s === "hold") return { variant: "warning", label: "Hold" };
    if (s === "confirmed") return { variant: "info", label: "Confirmada" };
    if (s === "active") return { variant: "default", label: "Activa" };
    if (s === "completed") return { variant: "outline", label: "Completada" };
    if (s === "draft") return { variant: "secondary", label: "Borrador" };
    return { variant: "outline", label: s || "—" };
  }
  if (s === "draft") return { variant: "secondary", label: "Borrador" };
  if (s === "signed") return { variant: "success", label: "Firmada" };
  return { variant: "info", label: s || "—" };
}

/** Historial vencido: quieto, borde. */
export function historyBadgeDisplay(label: string): BadgeDisplay {
  return { variant: "outline", label };
}

/** Hito próximo (≤30d): protagonista azul. */
export function upcomingBadgeDisplay(): BadgeDisplay & { title: string } {
  return { variant: "default", label: "≤30d", title: "Dentro de los próximos 30 días" };
}

/** Transitorio IA: celeste. El pulso lo pone el componente. */
export function generatingBadgeDisplay(): BadgeDisplay & { title: string } {
  return { variant: "info", label: "Generando resumen inteligente…", title: "Generando resumen" };
}

/** Hito Autorizada (OM registrado): éxito fijo con ✓. */
export function autorizadaBadgeDisplay(): BadgeDisplay & { title: string } {
  return { variant: "success", label: "Autorizada", title: "Hito: OM registrado, la orden está autorizada" };
}

/** IO sin dato (—): gris quieto, nunca "Borrador" inventado. */
export function ioEmptyBadgeDisplay(): BadgeDisplay & { title: string } {
  return { variant: "secondary", label: "—", title: "Estado de IO sin dato" };
}

/** Selección con X (pantallas elegidas): protagonista azul. */
export function selectionBadgeDisplay(): Pick<BadgeDisplay, "variant"> {
  return { variant: "default" };
}
