// Importa el GSheet DOOH (ANUNCIANTES + AGENCIAS + CONTACTOS; MARCAS se
// omite: sin tabla maestra, la marca se deriva de io_orders.brand) al
// tenant Smart Media. Idempotente: machea empresas por tax_id y contactos
// por (empresa, email); lo existente se actualiza, nada se duplica.
// Las cuentas (ATIENDE) exigen el vínculo agencia↔anunciante previo:
// se crean los links (ANUNCIANTES.AGENCIA) antes que las cuentas.
// Uso: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/import-gsheet-smartmedia.ts --dir=/tmp/opencode/gsheet [--store="Smart Media"] [--dry-run] [--actor=gsheet]
// Fuente: https://docs.google.com/spreadsheets/d/1nt1LDeIdvNhonq9mh54B_gPkLrMnosTGtSYgZkow81U (tab SELECTORES excluido).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getSupabase } from "@/lib/supabase";
import { normalizeCompany, normalizeContact } from "@/lib/crm";
import { TAX_ID_LABELS } from "@/lib/tax-id";
import { fail } from "./lib/run-once";

const args = process.argv.slice(2);
const opt = (name: string): string | null => {
  const p = `--${name}=`;
  const hit = args.find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length).trim() || null : null;
};
const has = (name: string): boolean => args.includes(`--${name}`);

/** CSV RFC4180 mínimo (comillas y comas internas, como las direcciones). */
function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  const out: Array<Record<string, string>> = [];
  if (rows.length === 0) return out;
  const hdr = rows[0].map((h) => h.trim());
  for (const r of rows.slice(1)) {
    const rec: Record<string, string> = {};
    hdr.forEach((h, j) => { rec[h] = (r[j] ?? "").trim(); });
    if (Object.values(rec).some((v) => v !== "")) out.push(rec);
  }
  return out;
}

function tinLabelOk(tipoTin: string, pais: string): boolean {
  if (!tipoTin) return true;
  const expected = TAX_ID_LABELS[pais.toUpperCase()] ?? null;
  return expected !== null && expected === tipoTin.toUpperCase();
}

async function main(): Promise<void> {
  const dir = opt("dir") ?? fail("GSH", "--dir requerido (carpeta con ANUNCIANTES.csv, AGENCIAS.csv, CONTACTOS.csv)");
  const storeName = opt("store") ?? "Smart Media";
  const dry = has("dry-run");
  const actor = opt("actor") ?? "gsheet";
  const db = getSupabase();

  const { data: store } = await db.from("sys_stores").select("id,name").ilike("name", storeName).limit(1).maybeSingle();
  if (!store) throw new Error(`Tienda no encontrada: ${storeName}`);
  const storeId = String((store as Record<string, unknown>).id);
  console.log(`Tienda: ${(store as Record<string, unknown>).name} (${storeId})${dry ? " [DRY-RUN]" : ""}`);

  const anunciantes = parseCsv(readFileSync(join(dir, "ANUNCIANTES.csv"), "utf8"));
  const agencias = parseCsv(readFileSync(join(dir, "AGENCIAS.csv"), "utf8"));
  const contactos = parseCsv(readFileSync(join(dir, "CONTACTOS.csv"), "utf8"));
  console.log(`Filas: ${anunciantes.length} anunciantes, ${agencias.length} agencias, ${contactos.length} contactos`);

  // 1) Empresas (agencias + anunciantes), idempotente por tax_id.
  const companyIdByName = new Map<string, string>(); // upper(nombre_comercial) -> id
  let coCreated = 0;
  let coUpdated = 0;
  let coSkipped = 0;
  /** Excel numera los RUC como float (20545232031.0): quedarnos con dígitos. */
  const cleanTin = (raw: string): string => {
    const t = (raw ?? "").trim();
    const m = t.match(/^(\d+)(?:\.0+)?$/);
    return m ? m[1] : t;
  };
  const upsertCompany = async (r: Record<string, string>, kind: "agencia" | "anunciante"): Promise<string | null> => {
    if (!r["NOMBRE_COMERCIAL"]) { coSkipped++; return null; } // fila de relleno
    if (!tinLabelOk(r["TIPO_TIN"] ?? "", r["PAÍS"] ?? "")) {
      throw new Error(`TIPO_TIN ${r["TIPO_TIN"]} no cuadra con país ${r["PAÍS"]} (${r["NOMBRE_COMERCIAL"]})`);
    }
    const parsed = normalizeCompany({
      name: r["NOMBRE_COMERCIAL"] ?? "",
      legal_name: r["NOMBRE_LEGAL"] ?? null,
      kind,
      tax_id: cleanTin(r["NUMERO_TIN"] ?? ""),
      domain: r["WEB"] ?? null,
      email: null,
      phone: r["TELÉFONO"] ?? null,
      address: r["DIRECCIÓN"] ?? null,
      city: r["CIUDAD"] ?? null,
      country: r["PAÍS"] ?? null,
      notes: null,
      external_ref: null,
      category_iab: kind === "anunciante" ? "IAB8" : null,
      provider_type: null,
    });
    if (!parsed.ok) throw new Error(`Empresa inválida ${r["NOMBRE_COMERCIAL"]}: ${parsed.error}`);
    const { data: existing } = await db
      .from("crm_companies")
      .select("id")
      .eq("store_id", storeId)
      .eq("tax_id", parsed.value.tax_id)
      .maybeSingle();
    if (existing) {
      const id = String((existing as Record<string, unknown>).id);
      if (!dry) {
        const { error } = await db.from("crm_companies").update({ ...parsed.value, updated_by: actor, updated_at: new Date().toISOString() }).eq("store_id", storeId).eq("id", id);
        if (error) throw new Error(`Company update: ${error.message}`);
      }
      coUpdated++;
      companyIdByName.set(parsed.value.name.toUpperCase(), id);
      return id;
    }
    if (dry) {
      const id = `dry:${parsed.value.tax_id}`;
      companyIdByName.set(parsed.value.name.toUpperCase(), id);
      coCreated++;
      return id;
    }
    const { data: ins, error } = await db
      .from("crm_companies")
      .insert({ store_id: storeId, ...parsed.value, created_by: actor, updated_by: actor })
      .select("id")
      .maybeSingle();
    if (error || !ins) throw new Error(`Company insert ${parsed.value.name}: ${error?.message ?? "sin id"}`);
    coCreated++;
    const id = String((ins as Record<string, unknown>).id);
    companyIdByName.set(parsed.value.name.toUpperCase(), id);
    return id;
  };
  for (const r of agencias) await upsertCompany(r, "agencia");
  for (const r of anunciantes) await upsertCompany(r, "anunciante");
  console.log(`Empresas: ${coCreated} creadas, ${coUpdated} actualizadas, ${coSkipped} filas de relleno omitidas`);

  // 2) Vínculos agencia↔anunciante (ANUNCIANTES.AGENCIA), idempotentes.
  let linksCreated = 0;
  let linksKept = 0;
  for (const r of anunciantes) {
    const advName = (r["NOMBRE_COMERCIAL"] ?? "").toUpperCase();
    const agName = (r["AGENCIA"] ?? "").toUpperCase();
    if (!agName) throw new Error(`Anunciante sin agencia: ${r["NOMBRE_COMERCIAL"]}`);
    const agencyId = companyIdByName.get(agName);
    const advId = companyIdByName.get(advName);
    if (!agencyId) throw new Error(`Agencia del sheet no resuelta: ${r["AGENCIA"]}`);
    if (!advId) throw new Error(`Anunciante no resuelto: ${r["NOMBRE_COMERCIAL"]}`);
    if (dry) { linksCreated++; continue; }
    const { error } = await db.from("crm_company_links").insert({
      store_id: storeId, agency_company_id: agencyId, advertiser_company_id: advId, origin: "manual", created_by: actor, updated_by: actor,
    });
    if (error) {
      if (error.code === "23505") linksKept++;
      else throw new Error(`Link ${agName}→${advName}: ${error.message}`);
    } else linksCreated++;
  }
  console.log(`Vínculos: ${linksCreated} creados, ${linksKept} ya existían`);

  // 3) Contactos, idempotentes por (empresa, email). Cuentas (ATIENDE) después.
  const contactIdByEmail = new Map<string, string>();
  let ctCreated = 0;
  let ctUpdated = 0;
  let ctSkipped = 0;
  for (const r of contactos) {
    if (!r["EMPRESA"] && !r["EMAIL"] && !r["TELÉFONO"] && !r["NOMBRE"]) { ctSkipped++; continue; } // relleno (PRINCIPAL=False arrastra)
    const coName = (r["EMPRESA"] ?? "").toUpperCase();
    const companyId = companyIdByName.get(coName);
    if (!companyId) throw new Error(`Contacto ${r["NOMBRE"]} ${r["APELLIDO"]}: empresa no resuelta (${r["EMPRESA"]})`);
    const parsed = normalizeContact({
      company_id: companyId,
      first_name: r["NOMBRE"] || null,
      last_name: r["APELLIDO"] || null,
      email: r["EMAIL"] || null,
      phone: r["TELÉFONO"] || null,
      job_title: r["CARGO"] || null,
      is_primary: /^true|sí|si|1|x$/i.test(r["PRINCIPAL"] ?? ""),
      notes: undefined,
    });
    if (!parsed.ok) throw new Error(`Contacto inválido ${r["EMAIL"]}: ${parsed.error}`);
    const emailKey = String(parsed.value.email ?? "").toLowerCase();
    const { data: existing } = await db
      .from("crm_contacts")
      .select("id")
      .eq("store_id", storeId)
      .eq("company_id", companyId)
      .ilike("email", String(parsed.value.email ?? ""))
      .limit(1)
      .maybeSingle();
    let contactId: string;
    if (existing) {
      contactId = String((existing as Record<string, unknown>).id);
      if (!dry) {
        const { error } = await db.from("crm_contacts").update({ ...parsed.value, updated_by: actor, updated_at: new Date().toISOString() }).eq("store_id", storeId).eq("id", contactId);
        if (error) throw new Error(`Contact update ${parsed.value.email}: ${error.message}`);
      }
      ctUpdated++;
    } else {
      if (dry) { contactId = `dry:${emailKey}`; }
      else {
        const { data: ins, error } = await db.from("crm_contacts").insert({ store_id: storeId, ...parsed.value, created_by: actor, updated_by: actor }).select("id").maybeSingle();
        if (error || !ins) throw new Error(`Contact insert ${parsed.value.email}: ${error?.message ?? "sin id"}`);
        contactId = String((ins as Record<string, unknown>).id);
      }
      ctCreated++;
    }
    if (emailKey) contactIdByEmail.set(emailKey, contactId);

    // Cuentas: el contacto atiende al anunciante ATIENDE (solo agencias).
    const atiende = (r["ATIENDE"] ?? "").toUpperCase();
    if (!atiende) continue;
    const advId = companyIdByName.get(atiende);
    if (!advId) throw new Error(`ATIENDE no resuelto: ${r["ATIENDE"]} (${r["EMAIL"]})`);
    if (dry) continue;
    const { data: link } = await db.from("crm_company_links").select("id").eq("store_id", storeId).eq("agency_company_id", companyId).eq("advertiser_company_id", advId).maybeSingle();
    if (!link) throw new Error(`Sin vínculo ${coName}→${atiende} para ${r["EMAIL"]}: vincular empresas primero`);
    const { error: accErr } = await db.from("crm_contact_accounts").upsert(
      { store_id: storeId, contact_id: contactId, agency_company_id: companyId, advertiser_company_id: advId, updated_by: actor },
      { onConflict: "store_id,contact_id,advertiser_company_id", ignoreDuplicates: false },
    );
    if (accErr) throw new Error(`Cuenta ${r["EMAIL"]}→${atiende}: ${accErr.message}`);
    await db.from("crm_contact_accounts").update({ created_by: actor }).eq("store_id", storeId).eq("contact_id", contactId).eq("advertiser_company_id", advId).is("created_by", null);
  }
  console.log(`Contactos: ${ctCreated} creados, ${ctUpdated} actualizados, ${ctSkipped} filas de relleno omitidas`);
  console.log(dry ? "DRY-RUN ok (sin escrituras)." : "Importación ok.");
}

main().catch((e) => fail("GSH", e));
