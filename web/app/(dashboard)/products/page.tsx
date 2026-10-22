import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AppCard, AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { readConnections } from "@/lib/store";
import { isSupabaseConfigured } from "@/lib/supabase";
import { resolveStoreId } from "@/lib/customers-db";
import { listProductsWithStats, normProductTitleLoose, type ProductWithStats } from "@/lib/product-stats";
import { resolveMarketScope } from "@/lib/markets";
import { isRealDbOrder } from "@/lib/medusa";
import { requireMyStoreAccess } from "@/lib/tenant";
import { ProductsList } from "./products-list";
import { ProductsSearch } from "./products-search";
import { ProductsEstadoSelect } from "./products-estado-select";
import { SyncButton } from "../customers/sync-button";
import { connection } from "next/server";

export const instant = false;

const DAY_MS = 86_400_000;

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; estado?: string; market?: string }>;
}) {
  // Request-time: usa Date.now() en el render (Cache Components no lo
  // difiere con `instant = false`; ver nota en app/(dashboard)/page.tsx).
  await connection();
  const conn = await readConnections();
  const connected = Boolean(conn.medusaUrl && conn.medusaToken);
  const dbReady = isSupabaseConfigured();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().toLowerCase();
  const estado = sp.estado === "inactivos" ? "inactivos" : sp.estado === "todos" ? "todos" : "activos";
  const marketParam = (sp.market ?? "").trim() || null;

  let rows: ProductWithStats[] = [];
  let total = 0;
  let truncated = false;
  let error: string | null = null;
  let synced = false;
  let dataPartial = false;

  if (connected && dbReady) {
    try {
      const storeId = await resolveStoreId(conn.medusaUrl);
      if (!storeId) {
        error = "Tienda aún sin sincronizar. Presiona Sincronizar.";
      } else if ((await requireMyStoreAccess(storeId).catch(() => null)) === false) {
        error = "Sin acceso a esta tienda. Pide a tu admin que te agregue en merchant_users.";
      } else {
        synced = true;
        // Filtro global ?market= (mismo scope que Finanzas/Customers).
        const scope = await resolveMarketScope(storeId, marketParam).catch(() => null);
        const res = await listProductsWithStats(storeId);
        rows = res.rows;
        total = res.total;
        truncated = res.truncated;
        if (scope?.market) {
          // Cifras del market: agrega orders del market en su moneda (igual que
          // Finanzas/get_top_products: solo lo vendido, intra-moneda).
          const { getSupabase } = await import("@/lib/supabase");
          const db = getSupabase();
          const viewCurrency = scope.market.currency.toUpperCase();
          const now = Date.now();
          const agg = new Map<string, { qty: number; rev: number; qty30: number; last: string | null; buyers: Set<string> }>();
          let ordersTruncated = false;
          for (let off = 0; ; off += 1000) {
            const oq = db
              .from("orders")
              .select("currency,items_json,placed_at,customer_id,status,payment_status,is_test")
              .eq("store_id", storeId)
              .or(`market_id.eq.${scope.market.id},country.is.null`)
              .order("placed_at", { ascending: false })
              .range(off, off + 999);
            const { data, error: qErr } = await oq;
            if (qErr) throw new Error(`Orders read: ${qErr.message}`);
            const orows = (data ?? []) as Array<Record<string, unknown>>;
            for (const o of orows) {
              if (!isRealDbOrder({
                status: typeof o.status === "string" ? o.status : null,
                payment_status: typeof o.payment_status === "string" ? o.payment_status : null,
                is_test: o.is_test === true,
              })) continue;
              const cur = String(o.currency ?? "").toUpperCase();
              if (cur !== viewCurrency) continue;
              const age = o.placed_at ? now - Date.parse(String(o.placed_at)) : NaN;
              const in30 = Number.isFinite(age) && age <= 30 * DAY_MS;
              const placed = typeof o.placed_at === "string" ? o.placed_at : null;
              for (const it of (Array.isArray(o.items_json) ? (o.items_json as Array<Record<string, unknown>>) : [])) {
                // Igual que el sync: la línea puede traer product_title distinto
                // de title (variante/rename). Antes solo se miraba title y esas
                // ventas se perdían en la tabla con ?market=.
                const raw = String(it.product_title ?? it.title ?? "");
                const t = normProductTitleLoose(raw);
                if (!t || t === "—") continue;
                const qty = Number(it.quantity ?? 0);
                if (!(qty > 0)) continue;
                let a = agg.get(t);
                if (!a) { a = { qty: 0, rev: 0, qty30: 0, last: null, buyers: new Set() }; agg.set(t, a); }
                a.qty += qty;
                a.rev += qty * Number(it.unit_price ?? 0);
                if (in30) a.qty30 += qty;
                if (placed && (!a.last || placed > a.last)) a.last = placed;
                if (typeof o.customer_id === "string") a.buyers.add(o.customer_id);
              }
            }
            if (orows.length < 1000) break;
            if (off + 1000 >= 20000) { ordersTruncated = true; break; }
          }
          if (ordersTruncated) dataPartial = true;
          // Un título puede existir en varias filas (draft + published): la venta
          // va solo a la primera, igual que computeProductStats (first-wins por
          // título). Sin esto, ambas filas duplican las mismas cifras.
          const seenTitle = new Set<string>();
          rows = rows.map((r) => {
            const k = normProductTitleLoose(r.title);
            if (seenTitle.has(k)) {
              return { ...r, currency: viewCurrency, qty_all: 0, revenue_all: 0, qty_30d: 0, buyers_all: 0, last_sold_at: null };
            }
            seenTitle.add(k);
            const a = agg.get(k);
            return {
              ...r,
              currency: viewCurrency,
              qty_all: a?.qty ?? 0,
              revenue_all: a?.rev ?? 0,
              qty_30d: a?.qty30 ?? 0,
              buyers_all: a?.buyers.size ?? 0,
              last_sold_at: a?.last ?? null,
            };
          });
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "DB read failed";
    }
  }

  // Filtro en servidor (simple, sin Matches raros): texto + estado.
  const filtered = rows.filter(
    (r) =>
      (!q || r.title.toLowerCase().includes(q)) &&
      (estado === "todos" || (estado === "activos" ? r.is_active : !r.is_active)),
  );
  // Conteos globales (sin filtro): la línea de resumen no depende del filtro.
  const activeTotal = rows.filter((r) => r.is_active).length;

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-8 p-6 md:p-8">
      <PageHeader
        eyebrow="Catálogo del tenant"
        title="Catálogo"
        description={`Qué ofrece el negocio y qué se mueve. Solo lectura: sin gestión de catálogo.${dataPartial ? " Muestra parcial (CAP 20k órdenes)." : ""}`}
        right={synced ? <SyncButton /> : undefined}
      />

      {!connected && (
        <AppCard
          footer={
            <Button
              render={<Link href="/settings" />}
              nativeButton={false}
              variant="outline"
              size="sm"
            >
              Ir a Settings
            </Button>
          }
        >
          <p className="text-sm text-muted-foreground">
            Conecta Medusa con tu usuario admin para traer el catálogo.
          </p>
        </AppCard>
      )}

      {connected && !dbReady && (
        <AppCardState>
          Supabase no configurado. Levanta el stack local (`supabase start`) y define
          SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en `web/.env.local`.
        </AppCardState>
      )}

      {error && <AppCard><p className="text-sm text-muted-foreground">{error}</p></AppCard>}

      {synced && !error && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2.5">
            <ProductsSearch q={sp.q ?? ""} estado={estado} market={marketParam} />
            <ProductsEstadoSelect estado={estado} q={sp.q ?? ""} market={marketParam} />
          </div>
          <ProductsList rows={filtered} total={total} truncated={truncated} activeTotal={activeTotal} inactiveTotal={rows.length - activeTotal} market={marketParam} />
        </div>
      )}
    </div>
  );
}
