// WhatsApp manual vía wa.me (click-to-chat): sin API, sin plantillas, sin costo.
// El humano abre el link, WhatsApp prellena el mensaje y lo envía desde su
// número. La única parte con truco es el formato: wa.me exige solo dígitos
// en formato internacional (sin `+`, espacios ni guiones).

/** Prefijos telefónicos por ISO2 (cobertura: LatAm + ES/US; se amplía a demanda). */
const CALLING_CODES: Record<string, string> = {
  PE: "51",
  MX: "52",
  CO: "57",
  CL: "56",
  AR: "54",
  EC: "593",
  BO: "591",
  PY: "595",
  UY: "598",
  BR: "55",
  VE: "58",
  CR: "506",
  PA: "507",
  DO: "1809",
  ES: "34",
  US: "1",
};

/**
 * Normaliza un teléfono crudo del sync a dígitos internacionales para wa.me.
 * - Quita todo lo no-dígito (espacios, `+`, guiones, paréntesis).
 * - Si ya trae código país conocido, se respeta.
 * - Si no, antepone el del `countryIso` (país del cliente).
 * Devuelve null cuando no hay cómo formar un número válido (→ solo email).
 */
export function normalizeForWaMe(raw: string | null, countryIso: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  // ¿Ya internacional? Coincide con algún código conocido + resto plausible.
  const codes = Object.values(CALLING_CODES).sort((a, b) => b.length - a.length);
  for (const code of codes) {
    if (digits.startsWith(code) && digits.length > code.length + 5) return digits;
  }
  // Nacional: anteponer el del país del cliente.
  const iso = (countryIso ?? "").trim().toUpperCase();
  const fallback = CALLING_CODES[iso];
  if (!fallback) return null;
  // Evita duplicar un 0 troncal ("098..." → código + "98...").
  const national = digits.replace(/^0+/, "");
  const full = fallback + national;
  if (full.length < 8 || full.length > 15) return null;
  return full;
}

/** Link click-to-chat con el mensaje prellenado. Null si el teléfono no sirve. */
export function buildWaMeUrl(opts: {
  phone: string | null;
  countryIso: string | null;
  text: string;
}): string | null {
  const digits = normalizeForWaMe(opts.phone, opts.countryIso);
  if (!digits || !opts.text.trim()) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(opts.text.trim().slice(0, 4000))}`;
}
