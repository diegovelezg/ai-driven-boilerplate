import Link from "next/link";
import { CircleArrowLeft } from "lucide-react";
import { connection } from "next/server";
import { AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { isSupabaseConfigured } from "@/lib/supabase";
import { requireMyStoreAccess, resolveActiveStoreId } from "@/lib/tenant";
import { listCrmCompanies } from "@/lib/crm-db";
import { NuevaOrdenForm } from "./nueva-form";

// Request-time: usa el cliente Supabase (timers/Date internos) en el render.
// Cache Components no lo difiere con `instant = false`; ver nota en
// app/(dashboard)/page.tsx.
export const instant = false;

export default async function NuevaOrdenPage() {
  await connection();
  const dbReady = isSupabaseConfigured();
  const activeStoreId = await resolveActiveStoreId();
  const connected = Boolean(activeStoreId);

  let companies: Array<{ id: string; name: string; kind: string | null }> = [];
  let screens: Array<{ id: string; name: string; detail: string | null; price_pen: number | null }> = [];
  let brands: string[] = [];
  let defaultCurrency = "PEN";
  let error: string | null = null;

  if (connected && dbReady) {
    try {
      const storeId = activeStoreId!;
      if ((await requireMyStoreAccess(storeId).catch(() => null)) === false) {
        error = "Sin acceso a esta tienda.";
      } else {
        const res = await listCrmCompanies(storeId, { pageSize: 200 });
        companies = res.rows.map((c) => ({ id: c.id, name: c.name, kind: c.kind }));
        const { getSupabase } = await import("@/lib/supabase");
        const db = getSupabase();
        const { data: storeRow } = await db
          .from("sys_stores")
          .select("shop_currency")
          .eq("id", storeId)
          .maybeSingle();
        defaultCurrency =
          String((storeRow as Record<string, unknown> | null)?.shop_currency ?? "PEN").toUpperCase() || "PEN";
        const { data: sc } = await db
          .from("inv_screens")
          .select("id,name,external_ref,technology,width_px,height_px,price_pen,inv_venues(name)")
          .eq("store_id", storeId)
          .eq("is_active", true)
          .order("name", { ascending: true })
          .limit(200);
        screens = ((sc ?? []) as Array<Record<string, unknown>>).map((s) => {
          const v = s.venues as unknown as { name?: unknown } | null;
          const venue = typeof v?.name === "string" ? v.name : "";
          const w = Number(s.width_px);
          const h = Number(s.height_px);
          const res = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? `${w}×${h}` : "";
          const detail = [s.external_ref, venue, s.technology, res]
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
        brands = [...new Set(((bm ?? []) as Array<Record<string, unknown>>).map((r) => String(r.brand ?? "").trim()).filter(Boolean))].sort((a, b) =>
          a.localeCompare(b, "es"),
        );
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "DB read failed";
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-8 p-6 md:p-8">
      <PageHeader
        eyebrow="DOOH"
        title="Nueva orden"
        description="Un solo periodo para toda la orden: elige pantallas, ponle precio a cada una y créala en borrador. OM y materiales llegan después, en su etapa."
        right={<Button render={<Link href="/orders" />} nativeButton={false} size="sm" variant="outline"><CircleArrowLeft />Volver</Button>}
      />
      {!connected && <AppCardState>Sin tienda. Importa inventario en /screens.</AppCardState>}
      {connected && !dbReady && <AppCardState>Supabase no configurado.</AppCardState>}
      {error && <AppCardState>{error}</AppCardState>}
      {connected && dbReady && !error && (
        <NuevaOrdenForm companies={companies} brands={brands} screens={screens} defaultCurrency={defaultCurrency} />
      )}
    </div>
  );
}
