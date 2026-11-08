"use client";

// Validación cliente para Nueva pantalla: espejo liviano del server action
// (`createScreenAction`). Error = borde del campo + toast (nunca burbujas
// nativas: los forms llevan noValidate).

export { FIELD_ERR_CLS } from "@/components/ui/form-feedback";

export type ScreenFieldKey = "name" | "venue" | "price" | "size" | "playback" | "impact";

export interface ScreenFieldValues {
  name: string;
  venueId: string;
  venueAddress: string;
  width: string;
  height: string;
  widthPx: string;
  heightPx: string;
  price: string;
  duration: string;
  plays: string;
  impact: string;
}

function optPositiveMetersOk(raw: string): boolean {
  const s = raw.trim().replace(",", ".");
  if (!s) return true;
  if (!/^\d+(\.\d+)?$/.test(s)) return false;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 && n <= 1000;
}

function optPositiveIntOk(raw: string): boolean {
  const s = raw.trim();
  if (!s) return true;
  if (!/^\d+$/.test(s)) return false;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0;
}

/** Devuelve la lista de campos inválidos con su mensaje (vacío = válido). */
export function validateScreenFields(v: ScreenFieldValues): Array<{ key: ScreenFieldKey; message: string }> {
  const out: Array<{ key: ScreenFieldKey; message: string }> = [];
  if (!v.name.trim()) out.push({ key: "name", message: "Nombre de pantalla requerido." });
  else if (v.name.trim().length > 200) out.push({ key: "name", message: "Nombre muy largo (máx 200)." });
  if (!v.venueAddress.trim()) {
    out.push({ key: "venue", message: "Dirección requerida (p. ej. Av. Pardo 793)." });
  } else if (v.venueAddress.trim().length > 300) {
    out.push({ key: "venue", message: "Dirección muy larga (máx 300)." });
  }
  if (!optPositiveMetersOk(v.width) || !optPositiveMetersOk(v.height)) {
    out.push({ key: "size", message: "Medidas inválidas: ancho/alto en metros (> 0)." });
  }
  if (!optPositiveIntOk(v.widthPx) || !optPositiveIntOk(v.heightPx)) {
    out.push({ key: "size", message: "Resolución inválida: ancho/alto en px (entero > 0)." });
  }
  const p = v.price.trim();
  if (p && (!/^\d+$/.test(p) || !Number.isSafeInteger(Number(p)))) {
    out.push({ key: "price", message: "Precio inválido (entero ≥ 0)." });
  }
  if (!optPositiveIntOk(v.duration)) {
    out.push({ key: "playback", message: "Duración inválida: segundos del spot (entero > 0)." });
  }
  if (!optPositiveIntOk(v.plays)) {
    out.push({ key: "playback", message: "Reproducciones inválidas: cantidad por día (entero > 0)." });
  }
  if (!optPositiveIntOk(v.impact)) {
    out.push({ key: "impact", message: "Impactos inválidos: cantidad por día (entero > 0)." });
  }
  return out;
}

/** Mapea un mensaje del server action al campo a resaltar. */
export function fieldsFromMessage(msg: string): ScreenFieldKey[] {
  if (/recinto|venue|dirección|direccion/i.test(msg)) return ["venue"];
  if (/precio/i.test(msg)) return ["price"];
  if (/medida|ancho|alto|tamaño|px|resolución|resolucion/i.test(msg)) return ["size"];
  if (/duraci|spot|segundo|reproduc|emisi|pasada|plays/i.test(msg)) return ["playback"];
  if (/impacto/i.test(msg)) return ["impact"];
  if (/nombre|pantalla/i.test(msg)) return ["name"];
  return [];
}
