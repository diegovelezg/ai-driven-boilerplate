// Proveedor email SendGrid (v3 /mail/send) vía fetch, sin SDK.
// La key vive en .data/connections.json (campo emailApiKey), nunca se loguea.
import type { CommMessage, CommResult } from "@/lib/comms/types";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Texto plano → HTML mínimo para el cuerpo del correo. */
export function textToHtml(text: string): string {
  const paras = text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
    .join("\n");
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5">${paras}</body></html>`;
}

export async function sendViaSendGrid(opts: {
  apiKey: string;
  from: string;
  msg: CommMessage;
}): Promise<CommResult> {
  const { apiKey, from, msg } = opts;
  if (!apiKey) return { ok: false, provider: "sendgrid", error: "Falta API key de SendGrid" };
  if (!from) return { ok: false, provider: "sendgrid", error: "Falta remitente (from)" };
  if (!msg.to || !msg.subject) {
    return { ok: false, provider: "sendgrid", error: "Falta destinatario o asunto" };
  }
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: msg.to }] }],
      from: { email: msg.from ?? from },
      subject: msg.subject,
      content: [
        { type: "text/plain", value: msg.text },
        { type: "text/html", value: msg.html ?? textToHtml(msg.text) },
      ],
    }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    return { ok: false, provider: "sendgrid", error: `SendGrid ${res.status}: ${body}` };
  }
  return { ok: true, provider: "sendgrid" };
}
