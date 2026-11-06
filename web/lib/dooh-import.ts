// Persistencia de importaciones Sheet/CSV → Supabase (server-only, service_role).
// Upsert-only por external_ref cuando existe; si no, inserta.
// kind=slots crea inventory_slots con loop default (60s/6×10s) si la pantalla no tiene.
import { getSupabase } from "@/lib/supabase";
import {
  headerIndex,
  normalizeCompanyRow,
  normalizeContactRow,
  normalizeScreenRow,
  normalizeVenueRow,
  parseCsv,
  type ImportKind,
  type ImportRowError,
} from "@/lib/sheet-import";
import { normalizeCompany, normalizeContact } from "@/lib/crm";

export interface ImportCommitResult {
  rows_seen: number;
  rows_ok: number;
  rows_failed: number;
  errors: ImportRowError[];
}

function cell(row: string[], idx: Map<string, number>, ...names: string[]): string {
  for (const n of names) {
    const i = idx.get(n);
    if (i !== undefined) return (row[i] ?? "").trim();
  }
  return "";
}

async function resolveCompanyId(
  db: ReturnType<typeof getSupabase>,
  storeId: string,
  ref: string,
): Promise<string | null> {
  // external_ref → tax_id → domain → name (case-insensitive).
  const r = ref.trim();
  if (!r) return null;
  const { data: byRef } = await db
    .from("companies")
    .select("id")
    .eq("store_id", storeId)
    .eq("external_ref", r)
    .maybeSingle();
  if (byRef) return (byRef as { id: string }).id;
  const { data: byTax } = await db
    .from("companies")
    .select("id")
    .eq("store_id", storeId)
    .eq("tax_id", r)
    .maybeSingle();
  if (byTax) return (byTax as { id: string }).id;
  const low = r.toLowerCase();
  const { data: byDomain } = await db
    .from("companies")
    .select("id")
    .eq("store_id", storeId)
    .eq("domain", low)
    .maybeSingle();
  if (byDomain) return (byDomain as { id: string }).id;
  const { data: byName } = await db
    .from("companies")
    .select("id")
    .eq("store_id", storeId)
    .ilike("name", r)
    .limit(1)
    .maybeSingle();
  if (byName) return (byName as { id: string }).id;
  return null;
}

export async function commitImport(
  storeId: string,
  kind: ImportKind,
  csvText: string,
  source: "sheet" | "csv",
  sourceUrl?: string,
): Promise<ImportCommitResult> {
  const db = getSupabase();
  const rows = parseCsv(csvText);
  const errors: ImportRowError[] = [];
  let ok = 0;
  if (rows.length === 0) {
    await logRun(storeId, kind, source, sourceUrl, 0, 0, 1, [{ row: 1, message: "CSV vacío" }]);
    return { rows_seen: 0, rows_ok: 0, rows_failed: 1, errors: [{ row: 1, message: "CSV vacío" }] };
  }
  const idx = headerIndex(rows[0]);
  const total = rows.length - 1;

  if (kind === "companies") {
    for (let i = 1; i < rows.length; i++) {
      const n = normalizeCompanyRow(rows[i], idx);
      if (!n.ok) {
        errors.push({ row: i + 1, message: n.error });
        continue;
      }
      const parsed = normalizeCompany({ ...n.value });
      if (!parsed.ok) {
        errors.push({ row: i + 1, message: parsed.error });
        continue;
      }
      // Dedupe idempotente dentro del tenant: external_ref → tax_id → domain → name.
      let companyId: string | null = null;
      const v = parsed.value;
      if (v.external_ref) {
        const { data } = await db
          .from("companies")
          .select("id")
          .eq("store_id", storeId)
          .eq("external_ref", v.external_ref)
          .maybeSingle();
        if (data) companyId = (data as { id: string }).id;
      }
      if (!companyId && v.tax_id) {
        const { data } = await db
          .from("companies")
          .select("id")
          .eq("store_id", storeId)
          .eq("tax_id", v.tax_id)
          .maybeSingle();
        if (data) companyId = (data as { id: string }).id;
      }
      if (!companyId && v.domain) {
        const { data } = await db
          .from("companies")
          .select("id")
          .eq("store_id", storeId)
          .eq("domain", v.domain)
          .maybeSingle();
        if (data) companyId = (data as { id: string }).id;
      }
      if (!companyId) {
        const { data } = await db
          .from("companies")
          .select("id")
          .eq("store_id", storeId)
          .ilike("name", v.name)
          .limit(1)
          .maybeSingle();
        if (data) companyId = (data as { id: string }).id;
      }
      if (!companyId) {
        const { data, error } = await db
          .from("companies")
          .insert({ store_id: storeId, ...v })
          .select("id")
          .maybeSingle();
        if (error || !data) {
          errors.push({ row: i + 1, message: `DB: ${error?.message ?? "sin id"}` });
          continue;
        }
        companyId = (data as { id: string }).id;
      } else if (v.external_ref) {
        // Completa external_ref si la empresa ya existía sin él (import viejo).
        await db
          .from("companies")
          .update({ external_ref: v.external_ref })
          .eq("id", companyId)
          .is("external_ref", null);
      }
      // Tipo: se fija si venía en la fila y la empresa aún no tiene.
      if (v.kind) {
        await db.from("companies").update({ kind: v.kind }).eq("id", companyId).is("kind", null);
      }
      ok++;
    }
  } else if (kind === "contacts") {
    for (let i = 1; i < rows.length; i++) {
      const n = normalizeContactRow(rows[i], idx);
      if (!n.ok) {
        errors.push({ row: i + 1, message: n.error });
        continue;
      }
      const companyId = await resolveCompanyId(db, storeId, n.value.company_ref);
      if (!companyId) {
        errors.push({ row: i + 1, message: `empresa no encontrada: ${n.value.company_ref}` });
        continue;
      }
      const parsed = normalizeContact({ ...n.value, company_id: companyId });
      if (!parsed.ok) {
        errors.push({ row: i + 1, message: parsed.error });
        continue;
      }
      // Dedupe idempotente por empresa: mismo email o mismo teléfono → ya existe.
      let dupe = false;
      if (parsed.value.email) {
        const { data } = await db
          .from("contacts")
          .select("id")
          .eq("company_id", companyId)
          .ilike("email", parsed.value.email)
          .limit(1)
          .maybeSingle();
        if (data) dupe = true;
      }
      if (!dupe && parsed.value.phone) {
        const { data } = await db
          .from("contacts")
          .select("id")
          .eq("company_id", companyId)
          .eq("phone", parsed.value.phone)
          .limit(1)
          .maybeSingle();
        if (data) dupe = true;
      }
      if (dupe) {
        ok++; // re-import no duplica
        continue;
      }
      if (parsed.value.is_primary) {
        // Solo un principal por empresa: degrada el anterior.
        await db.from("contacts").update({ is_primary: false }).eq("company_id", companyId).eq("is_primary", true);
      }
      const { error } = await db.from("contacts").insert({ store_id: storeId, ...parsed.value });
      if (error) {
        errors.push({ row: i + 1, message: `DB: ${error.message}` });
        continue;
      }
      ok++;
    }
  } else if (kind === "venues") {
    for (let i = 1; i < rows.length; i++) {
      const n = normalizeVenueRow(rows[i], idx);
      if (!n.ok) {
        errors.push({ row: i + 1, message: n.error });
        continue;
      }
      let supplierId: string | null = null;
      if (n.value.ownership === "supplier" && n.value.supplier_ref) {
        supplierId = await resolveCompanyId(db, storeId, n.value.supplier_ref);
        if (!supplierId) {
          errors.push({ row: i + 1, message: `proveedor no encontrado: ${n.value.supplier_ref}` });
          continue;
        }
      }
      const payload = {
        store_id: storeId,
        name: n.value.name,
        venue_type: n.value.venue_type,
        latitude: n.value.latitude,
        longitude: n.value.longitude,
        city: n.value.city,
        country: n.value.country,
        timezone: n.value.timezone,
        ownership: n.value.ownership,
        supplier_company_id: supplierId,
        source,
        external_ref: n.value.external_ref,
      };
      const { error } = n.value.external_ref
        ? await db
            .from("venues")
            .upsert(payload, { onConflict: "store_id,external_ref" })
            .then((r) => ({ error: r.error }))
        : await db
            .from("venues")
            .insert(payload)
            .then((r) => ({ error: r.error }));
      if (error) {
        errors.push({ row: i + 1, message: `DB: ${error.message}` });
        continue;
      }
      ok++;
    }
  } else if (kind === "screens") {
    for (let i = 1; i < rows.length; i++) {
      const n = normalizeScreenRow(rows[i], idx);
      if (!n.ok) {
        errors.push({ row: i + 1, message: n.error });
        continue;
      }
      // venue por external_ref o nombre.
      let venueId: string | null = null;
      const { data: v1 } = await db
        .from("venues")
        .select("id")
        .eq("store_id", storeId)
        .eq("external_ref", n.value.venue_ref)
        .maybeSingle();
      if (v1) venueId = (v1 as { id: string }).id;
      if (!venueId) {
        const { data: v2 } = await db
          .from("venues")
          .select("id")
          .eq("store_id", storeId)
          .eq("name", n.value.venue_ref)
          .maybeSingle();
        if (v2) venueId = (v2 as { id: string }).id;
      }
      if (!venueId) {
        errors.push({ row: i + 1, message: `venue no encontrado: ${n.value.venue_ref}` });
        continue;
      }
      let supplierId: string | null = null;
      if (n.value.supplier_ref) {
        supplierId = await resolveCompanyId(db, storeId, n.value.supplier_ref);
      }
      const payload = {
        store_id: storeId,
        venue_id: venueId,
        name: n.value.name,
        width_px: n.value.width_px,
        height_px: n.value.height_px,
        orientation: n.value.orientation,
        technology: n.value.technology,
        placement: n.value.placement,
        player_id: n.value.player_id,
        ownership: n.value.ownership,
        supplier_company_id: supplierId,
        source,
        external_ref: n.value.external_ref,
      };
      let screenId: string | null = null;
      if (n.value.external_ref) {
        const { data, error } = await db
          .from("screens")
          .upsert(payload, { onConflict: "store_id,external_ref" })
          .select("id")
          .maybeSingle();
        if (error) {
          errors.push({ row: i + 1, message: `DB: ${error.message}` });
          continue;
        }
        screenId = data ? (data as { id: string }).id : null;
      } else {
        const { data, error } = await db.from("screens").insert(payload).select("id").maybeSingle();
        if (error || !data) {
          errors.push({ row: i + 1, message: `DB: ${error?.message ?? "sin id"}` });
          continue;
        }
        screenId = (data as { id: string }).id;
      }
      // Loop + slots auto: si el CSV trae loop_*, crea/asegura template y slots.
      if (screenId && n.value.loop_slots && n.value.loop_duration_ms && n.value.slot_duration_ms) {
        const { data: tpl } = await db
          .from("loop_templates")
          .insert({
            store_id: storeId,
            name: `${n.value.name} · ${n.value.loop_slots}×${n.value.slot_duration_ms}ms`,
            duration_ms: n.value.loop_duration_ms,
            max_slots: n.value.loop_slots,
            slot_duration_ms: n.value.slot_duration_ms,
          })
          .select("id")
          .maybeSingle();
        const tplId = tpl ? (tpl as { id: string }).id : null;
        const sov = Number((100 / n.value.loop_slots).toFixed(2));
        for (let s = 1; s <= n.value.loop_slots; s++) {
          await db.from("inventory_slots").upsert(
            {
              store_id: storeId,
              screen_id: screenId,
              loop_template_id: tplId,
              slot_index: s,
              share_of_voice_target: sov,
            },
            { onConflict: "screen_id,slot_index", ignoreDuplicates: true },
          );
        }
      }
      ok++;
    }
  } else {
    // slots
    for (let i = 1; i < rows.length; i++) {
      const ref = cell(rows[i], idx, "screen_ref", "screen", "pantalla");
      const si = Number(cell(rows[i], idx, "slot_index", "slot", "posicion", "posición"));
      const sovRaw = cell(rows[i], idx, "share_of_voice", "sov");
      const progRaw = cell(rows[i], idx, "programmatic", "programatico", "programático").toLowerCase();
      if (!ref || !Number.isInteger(si) || si < 1) {
        errors.push({ row: i + 1, message: "screen_ref y slot_index ≥ 1 requeridos" });
        continue;
      }
      let screenId: string | null = null;
      const { data: s1 } = await db
        .from("screens")
        .select("id")
        .eq("store_id", storeId)
        .eq("external_ref", ref)
        .maybeSingle();
      if (s1) screenId = (s1 as { id: string }).id;
      if (!screenId) {
        const { data: s2 } = await db
          .from("screens")
          .select("id")
          .eq("store_id", storeId)
          .eq("name", ref)
          .maybeSingle();
        if (s2) screenId = (s2 as { id: string }).id;
      }
      if (!screenId) {
        errors.push({ row: i + 1, message: `pantalla no encontrada: ${ref}` });
        continue;
      }
      const { error } = await db.from("inventory_slots").upsert(
        {
          store_id: storeId,
          screen_id: screenId,
          slot_index: si,
          share_of_voice_target: sovRaw ? Number(sovRaw) : null,
          is_programmatic_allowed: ["true", "1", "si", "sí", "yes"].includes(progRaw),
          external_ref: cell(rows[i], idx, "external_ref", "ref") || null,
        },
        { onConflict: "screen_id,slot_index" },
      );
      if (error) {
        errors.push({ row: i + 1, message: `DB: ${error.message}` });
        continue;
      }
      ok++;
    }
  }

  await logRun(storeId, kind, source, sourceUrl, total, ok, errors.length, errors.slice(0, 50));
  return { rows_seen: total, rows_ok: ok, rows_failed: errors.length, errors: errors.slice(0, 100) };
}

async function logRun(
  storeId: string,
  kind: ImportKind,
  source: "sheet" | "csv",
  sourceUrl: string | undefined,
  seen: number,
  rOk: number,
  failed: number,
  errors: ImportRowError[],
) {
  try {
    await getSupabase().from("import_runs").insert({
      store_id: storeId,
      kind,
      source,
      source_url: sourceUrl ?? null,
      rows_seen: seen,
      rows_ok: rOk,
      rows_failed: failed,
      errors_json: errors,
    });
  } catch {
    // auditoría best-effort
  }
}
