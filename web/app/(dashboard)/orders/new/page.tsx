import { connection } from "next/server";
import { AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { loadPageData } from "@/lib/page-data";
import { listCrmCompanies } from "@/lib/crm-db";
import { normalizeCurrency } from "@/lib/currency";
import { NuevaOrdenForm } from "./nueva-form";

// Request-time: usa el cliente Supabase (timers/Date internos) en el render.
// Cache Components no lo difiere con `instant = false`; ver nota en
// app/(dashboard)/page.tsx.
export const instant = false;

export default async function NuevaOrdenPage() {
  await connection();
  const { data, connected, dbReady, error } = await loadPageData(
    async (storeId) => {
      const res = await listCrmCompanies(storeId, { pageSize: 200 });
      const companies = res.rows.map((c) => ({ id: c.id, name: c.name, kind: c.kind }));
      const { getSupabase } = await import("@/lib/supabase");
      const db = getSupabase();
      const { data: storeRow } = await db
        .from("sys_stores")
        .select("shop_currency")
        .eq("id", storeId)
        .maybeSingle();
      const defaultCurrency =
        normalizeCurrency((storeRow as Record<string, unknown> | null)?.shop_currency ?? "PEN");
      const { data: sc } = await db
        .from("inv_screens")
        .select("id,name,external_ref,technology,width_px,height_px,price_pen,supplier_company_id,inv_venues!screens_venue_id_fkey(name,district,city)")
        .eq("store_id", storeId)
        .eq("is_active", true)
        .order("name", { ascending: true })
        .limit(200);
      const screenRows = ((sc ?? []) as Array<Record<string, unknown>>);
      // Proveedores en batch (mismo patrón que listScreensLegacy): el
      // picker indexa proveedor como la vista principal de screens.
      const supIds = [...new Set(screenRows.map((s) => s.supplier_company_id).filter((v): v is string => !!v))];
      let supBy = new Map<string, string>();
      if (supIds.length > 0) {
        const { data: sups } = await db
          .from("crm_companies")
          .select("id,name")
          .eq("store_id", storeId)
          .in("id", supIds);
        supBy = new Map(((sups ?? []) as Array<Record<string, unknown>>).map((c) => [String(c.id), String(c.name ?? "")]));
      }
      const screens = screenRows.map((s) => {
        const v = s.inv_venues as unknown as { name?: unknown; district?: unknown; city?: unknown } | null;
        const venue = typeof v?.name === "string" ? v.name : "";
        const district = typeof v?.district === "string" ? v.district : "";
        const city = typeof v?.city === "string" ? v.city : "";
        const supplier = typeof s.supplier_company_id === "string" ? (supBy.get(s.supplier_company_id) ?? "") : "";
        const w = Number(s.width_px);
        const h = Number(s.height_px);
        const res = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? `${w}×${h}` : "";
        const detail = [s.external_ref, venue, district, city, supplier, s.technology, res]
          .map((x) => String(x ?? "").trim())
          .filter(Boolean)
          .join(" · ");
        return {
          id: String(s.id),
          name: String(s.name ?? ""),
          detail: detail || null,
          price_pen: s.price_pen === null || s.price_pen === undefined ? null : Number(s.price_pen),
        };
      });
      const { data: bm } = await db.from("io_orders").select("brand").eq("store_id", storeId).not("brand", "is", null).limit(200);
      const brands = [...new Set(((bm ?? []) as Array<Record<string, unknown>>).map((r) => String(r.brand ?? "").trim()).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b, "es"),
      );
      return { companies, screens, brands, defaultCurrency };
    },
    {
      companies: [] as Array<{ id: string; name: string; kind: string | null }>,
      screens: [] as Array<{ id: string; name: string; detail: string | null; price_pen: number | null }>,
      brands: [] as string[],
      defaultCurrency: "PEN",
    },
  );
  const { companies, screens, brands, defaultCurrency } = data;

  return (
    <div className="page-shell max-w-[860px]">
      <PageHeader
        eyebrow="DOOH"
        title="Nueva orden"
        description="Elige pantallas, define sus precios y guárdala como borrador. Después podrás completar autorización y materiales."
        backHref="/orders"
      />
      {!connected && <AppCardState>Sin tienda conectada.</AppCardState>}
      {connected && !dbReady && <AppCardState>Base de datos no disponible.</AppCardState>}
      {error && <AppCardState>{error}</AppCardState>}
      {connected && dbReady && !error && (
        <NuevaOrdenForm companies={companies} brands={brands} screens={screens} defaultCurrency={defaultCurrency} />
      )}
    </div>
  );
}
