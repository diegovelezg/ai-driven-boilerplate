"use server";

import { revalidatePath } from "next/cache";
import { commitImport } from "@/lib/dooh-import";
import { sheetUrlToCsvUrl, validateImportCsv, type ImportKind } from "@/lib/sheet-import";
import { requireMyStoreAccess } from "@/lib/tenant";

export interface ImportState {
  ok: boolean;
  message: string;
  seen?: number;
  imported?: number;
  failed?: number;
  errors?: Array<{ row: number; message: string }>;
}

const KINDS: ImportKind[] = ["companies", "contacts", "venues", "screens", "slots"];

async function resolveTenantStoreId(): Promise<{ storeId: string } | { error: string }> {
  // Fail-closed: exige sesión + membresía. Nunca autocrea tenants.
  const { resolveActiveStoreId } = await import("@/lib/tenant");
  const storeId = await resolveActiveStoreId().catch(() => null);
  if (!storeId) return { error: "Sin tienda: inicia sesión con acceso a un tenant." };
  if ((await requireMyStoreAccess(storeId).catch(() => false)) === false) {
    return { error: "Sin acceso a esta tienda." };
  }
  return { storeId };
}

async function fetchCsvText(sourceUrl: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const t = sourceUrl.trim();
  if (!t) return { ok: false, error: "URL vacía." };
  try {
    const r = await fetch(t, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) return { ok: false, error: `Descarga falló: HTTP ${r.status}` };
    return { ok: true, text: await r.text() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Descarga falló." };
  }
}

export async function previewSheetImportAction(input: {
  kind: ImportKind;
  url: string;
}): Promise<ImportState> {
  if (!KINDS.includes(input.kind)) return { ok: false, message: "Tipo inválido." };
  // Preview con fetch saliente: exige sesión + membresía a algún tenant.
  const t = await resolveTenantStoreId();
  if ("error" in t) return { ok: false, message: t.error };
  const csvUrl = sheetUrlToCsvUrl(input.url);
  if (!csvUrl) return { ok: false, message: "URL de Google Sheets inválida (pega el link del documento)." };
  const dl = await fetchCsvText(csvUrl);
  if (!dl.ok) return { ok: false, message: dl.error };
  const v = validateImportCsv(input.kind, dl.text);
  return {
    ok: v.errors.length === 0,
    message: v.errors.length === 0 ? `${v.ok}/${v.total} filas válidas.` : `${v.ok}/${v.total} válidas, ${v.errors.length} con error.`,
    seen: v.total,
    imported: v.ok,
    failed: v.errors.length,
    errors: v.errors.slice(0, 20),
  };
}

export async function commitSheetUrlImportAction(input: {
  kind: ImportKind;
  url: string;
}): Promise<ImportState> {
  if (!KINDS.includes(input.kind)) return { ok: false, message: "Tipo inválido." };
  const t = await resolveTenantStoreId();
  if ("error" in t) return { ok: false, message: t.error };
  const csvUrl = sheetUrlToCsvUrl(input.url);
  if (!csvUrl) return { ok: false, message: "URL de Google Sheets inválida." };
  const dl = await fetchCsvText(csvUrl);
  if (!dl.ok) return { ok: false, message: dl.error };
  const r = await commitImport(t.storeId, input.kind, dl.text, "sheet", input.url.trim());
  revalidatePath("/screens");
  revalidatePath("/companies");
  return {
    ok: r.rows_failed === 0,
    message: `Importadas ${r.rows_ok}/${r.rows_seen} filas (${r.rows_failed} errores).`,
    seen: r.rows_seen,
    imported: r.rows_ok,
    failed: r.rows_failed,
    errors: r.errors.slice(0, 20),
  };
}

export async function commitCsvTextImportAction(input: {
  kind: ImportKind;
  csv: string;
}): Promise<ImportState> {
  if (!KINDS.includes(input.kind)) return { ok: false, message: "Tipo inválido." };
  if (!input.csv.trim()) return { ok: false, message: "CSV vacío." };
  const t = await resolveTenantStoreId();
  if ("error" in t) return { ok: false, message: t.error };
  const r = await commitImport(t.storeId, input.kind, input.csv, "csv");
  revalidatePath("/screens");
  revalidatePath("/companies");
  return {
    ok: r.rows_failed === 0,
    message: `Importadas ${r.rows_ok}/${r.rows_seen} filas (${r.rows_failed} errores).`,
    seen: r.rows_seen,
    imported: r.rows_ok,
    failed: r.rows_failed,
    errors: r.errors.slice(0, 20),
  };
}
