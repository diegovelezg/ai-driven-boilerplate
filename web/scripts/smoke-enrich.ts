// Smoke test de enriquecimiento (mitad 1: sin LLM).
// Uso: npx tsx scripts/smoke-enrich.ts
// Toma un customer random de la tienda conectada (tupantalla/Medusa),
// clasifica su dominio (webmail vs negocio) y, si es negocio, hace fetch del home.
import { readFileSync } from "node:fs";

const conn = JSON.parse(readFileSync(".data/connections.json", "utf-8"));
const base = String(conn.medusaUrl).replace(/\/+$/, "");
const token = String(conn.medusaToken);

// Lista mínima de webmails para el smoke test (el real será ~4.500 dominios offline).
const WEBMAIL = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.es", "outlook.com", "outlook.es",
  "live.com", "msn.com", "yahoo.com", "yahoo.es", "ymail.com", "icloud.com", "me.com",
  "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.net", "zoho.com", "yandex.com",
]);

interface MedusaCustomer {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  company_name?: string | null;
  billing_address?: { company?: string | null } | null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function medusaCustomers(limit: number): Promise<{ rows: MedusaCustomer[]; count: number }> {
  const res = await fetch(`${base}/admin/customers?limit=${limit}&offset=0`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return { rows: (data?.customers ?? []) as MedusaCustomer[], count: Number(data?.count ?? 0) };
}

async function main() {
  const { rows, count } = await medusaCustomers(100);
  console.log(`Customers disponibles: ${count} (página: ${rows.length})\n`);
  if (!rows.length) throw new Error("No hay customers.");

  // Clasificación de toda la página (para ver la proporción).
  let business = 0;
  let webmail = 0;
  let noDomain = 0;
  for (const c of rows) {
    const d = String(c.email ?? "").split("@")[1]?.toLowerCase() ?? "";
    if (!d) noDomain++;
    else if (WEBMAIL.has(d)) webmail++;
    else business++;
  }
  console.log(`Proporción en la página → negocio: ${business}, webmail: ${webmail}, sin dominio: ${noDomain}\n`);

  // Para el smoke test priorizamos un dominio de negocio (es el caso a validar).
  const businessRows = rows.filter((r) => {
    const d = String(r.email ?? "").split("@")[1]?.toLowerCase() ?? "";
    return d && !WEBMAIL.has(d);
  });
  const pool = businessRows.length ? businessRows : rows;
  const c = pool[Math.floor(Math.random() * pool.length)];
  const email = String(c.email ?? "");
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  const isBusiness = !!domain && !WEBMAIL.has(domain);
  const name = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim();

  console.log("—— CUSTOMER RANDOM ——");
  console.log(JSON.stringify({
    id: c.id,
    email,
    name: name || null,
    company: c.company_name ?? c.billing_address?.company ?? null,
    domain: domain || null,
    clasificacion: isBusiness ? "NEGOCIO (B2B)" : "PERSONAL/webmail (B2C)",
  }, null, 2));

  if (!isBusiness) {
    console.log("\nDominio no es de negocio → no se enriquece (correcto).");
    return;
  }

  console.log("\n—— SCRAPE HOME ——");
  for (const url of [`https://${domain}`, `https://www.${domain}`]) {
    try {
      const r = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; AIRetentionEngineBot/0.1)" },
      });
      const html = await r.text();
      const text = htmlToText(html);
      console.log(`${url} → HTTP ${r.status} · ${text.length} chars de texto`);
      console.log(text.slice(0, 700) + (text.length > 700 ? " …" : ""));
      return;
    } catch (e) {
      console.log(`${url} → falló: ${e instanceof Error ? e.message : e}`);
    }
  }
}

main().catch((e) => {
  console.error("\nSMOKE FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
