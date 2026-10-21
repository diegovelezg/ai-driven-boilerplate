// Caché del switch email ↔ whatsapp (módulo neutro, sin imports server:
// se usa desde review-actions y desde tests). Una sola fila viva por cliente.
import { COPYWRITER_GEN, isFreshGenerator } from "./copywriter-gen";

export interface ChannelVariant {
  subject: string | null;
  body: string;
  generator: string | null;
  at: string;
  manual?: boolean;
}

/** Lee `evidence_json.variants` sin romper con evidencias viejas. */
export function getChannelVariants(
  evidence: Record<string, unknown> | null | undefined,
): Record<string, ChannelVariant> {
  const v = (evidence?.variants as Record<string, unknown> | null) ?? null;
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return v as Record<string, ChannelVariant>;
}

/** ¿Esta variante guardada se puede mostrar sin regenerar? Fresca (sello
 *  actual), con cuerpo y topes del canal (whatsapp ≤450, email con asunto
 *  y ≤800). Las stale no se reutilizan: el envío las frena igual. */
export function isReusableChannelVariant(
  channel: "email" | "whatsapp",
  variant: ChannelVariant | null | undefined,
): boolean {
  if (!variant || typeof variant.body !== "string") return false;
  const body = variant.body.trim();
  if (!body) return false;
  if (!isFreshGenerator(variant.generator)) return false;
  if (channel === "whatsapp") {
    return body.length <= 450;
  }
  const subject = (variant.subject ?? "").trim();
  if (!subject) return false;
  return body.length <= 800;
}

export { COPYWRITER_GEN };
