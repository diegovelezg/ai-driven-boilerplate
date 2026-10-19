// Capacidades de contacto por cliente: qué canales se pueden ofrecer.
// El canal es propiedad del cliente (qué datos tiene), no del merchant.
// El setting `defaultChannel` solo desempata cuando hay ambos.
import { normalizeForWaMe } from "@/lib/comms/whatsapp/wame";

export type Capability = "email-only" | "whatsapp-only" | "both" | "none";

export interface ContactCapabilities {
  hasEmail: boolean;
  hasWhatsapp: boolean;
  /** Dígitos internacionales para wa.me (null si no normalizable). */
  waDigits: string | null;
  capability: Capability;
}

function validEmail(email: string | null): boolean {
  if (!email) return false;
  const e = email.trim();
  return e.length >= 5 && e.includes("@") && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

export function resolveContact(opts: {
  email: string | null;
  phone: string | null;
  countryIso: string | null;
}): ContactCapabilities {
  const hasEmail = validEmail(opts.email);
  const waDigits = normalizeForWaMe(opts.phone, opts.countryIso);
  const hasWhatsapp = waDigits !== null;
  const capability: Capability =
    hasEmail && hasWhatsapp ? "both" : hasEmail ? "email-only" : hasWhatsapp ? "whatsapp-only" : "none";
  return { hasEmail, hasWhatsapp, waDigits, capability };
}
