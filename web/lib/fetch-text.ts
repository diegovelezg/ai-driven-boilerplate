// Fetch de homepages para research (company-research + ai/investigate).
// Puro salvo el fetch: mismo UA/timeout, mismo umbral mínimo de texto.
// `maxChars` trunca (ai/investigate usa 6000 para el LLM); sin tope se
// devuelve el texto completo.

const FETCH_UA = "Mozilla/5.0 (compatible; DoohBot/0.1)";
const FETCH_TIMEOUT_MS = 12_000;

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchHomepageText(
  domain: string,
  maxChars?: number,
): Promise<{ text: string; url: string } | null> {
  for (const url of [`https://${domain}`, `https://www.${domain}`]) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": FETCH_UA },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const text = htmlToText(await res.text());
      if (text.length < 40) continue;
      return { text: maxChars ? text.slice(0, maxChars) : text, url: res.url || url };
    } catch {
      // Prueba la siguiente variante (con o sin www).
      continue;
    }
  }
  return null;
}
