import { getMyActiveStore, requireMyStoreAccess } from "@/lib/tenant";
import { isSupabaseConfigured } from "@/lib/supabase";
import { isCompanyKind } from "@/lib/crm";
import { parseCompaniesSort } from "@/lib/crm-db";
import { parseBrandsSort } from "@/lib/brand-db";
import { minorToMajor, toCsv, type CsvCell } from "@/lib/csv";
import { toISODateUTC } from "@/lib/format";

// GET /api/export?entity=companies|contacts|brands|orders|screens + mismos filtros
// de cada vista (q, tipo, company, stage, billing, proveedor, ciudad, estado,
// sort, dir, store).
// Exporta lo filtrado (empresas/pantallas paginan en bucle hasta 2000).
// Contactos topa en 200 y órdenes en 200 (límite de sus lecturas): si se
// alcanza, se declara con `X-Export-Truncated: 1`, nunca silencioso.
// CSV RFC4180 con coma + BOM para Excel/Sheets.
export async function GET(req: Request) {
  if (!isSupabaseConfigured()) {
    return new Response("Base de datos no disponible.", { status: 500 });
  }
  const url = new URL(req.url);
  const sp = url.searchParams;
  const entity = (sp.get("entity") ?? "").trim();
  if (!["companies", "contacts", "brands", "orders", "screens"].includes(entity)) {
    return new Response("entity debe ser companies|contacts|brands|orders|screens.", { status: 400 });
  }
  try {
    const { active } = await getMyActiveStore(sp.get("store"));
    if (!active) return new Response("Sin tienda.", { status: 400 });
    if ((await requireMyStoreAccess(active.id).catch(() => false)) === false) {
      return new Response("Sin acceso a esta tienda.", { status: 403 });
    }
    const storeId = active.id;
    const q = (sp.get("q") ?? "").trim().slice(0, 100);
    const stamp = toISODateUTC(new Date());

    if (entity === "companies") {
      const kindRaw = sp.get("type") ?? sp.get("tipo");
      const kind = isCompanyKind(kindRaw) ? kindRaw : null;
      const { key, dir } = parseCompaniesSort({ sort: sp.get("sort") ?? undefined, dir: sp.get("dir") ?? undefined });
      const { listCrmCompanies } = await import("@/lib/crm-db");
      const rows: CsvCell[][] = [];
      const PAGE = 200;
      for (let page = 1; page <= 10; page += 1) {
        const res = await listCrmCompanies(storeId, { q, kind, sortKey: key, sortDir: dir, page, pageSize: PAGE });
        for (const c of res.rows) {
          rows.push([c.id, c.name, c.kind ?? "", c.tax_id ?? "", c.domain ?? "", c.email ?? "", c.phone ?? "", c.city ?? "", c.country ?? "", c.contacts_count]);
        }
        if (res.rows.length < PAGE || rows.length >= res.total) break;
      }
      return csv(`empresas-${stamp}.csv`, ["id", "nombre", "tipo", "tax_id", "dominio", "email", "telefono", "ciudad", "pais", "contactos"], rows);
    }

    if (entity === "contacts") {
      const companyId = (sp.get("company") ?? sp.get("empresa") ?? "").trim() || undefined;
      const { listCrmContacts } = await import("@/lib/crm-db");
      const { rows: list, truncated } = await listCrmContacts(storeId, { q, companyId, limit: 200 });
      const rows = list.map((c) => [
        c.id,
        c.first_name ?? "",
        c.last_name ?? "",
        c.company_name ?? "",
        c.email ?? "",
        c.phone ?? "",
        c.job_title ?? "",
        c.is_primary,
      ]);
      // Techo 200 de listCrmContacts (límite UI): se declara, no se silencia.
      return csv(`contactos-${stamp}.csv`, ["id", "nombres", "apellidos", "empresa", "email", "telefono", "cargo", "es_principal"], rows, { truncated });
    }

    if (entity === "brands") {
      const { key, dir } = parseBrandsSort({ sort: sp.get("sort") ?? undefined, dir: sp.get("dir") ?? undefined });
      const { listBrands } = await import("@/lib/brand-db");
      const list = await listBrands(storeId, { q, sortKey: key, sortDir: dir });
      // Moneda real por marca (nunca "PEN" fijo: la marca cruza PEN+USD).
      // Mixta → una fila por moneda con su total (nunca sumar mixto).
      const rows: CsvCell[][] = [];
      for (const b of list) {
        const curs = b.currencies.length > 0 ? b.currencies : [""];
        if (curs.length === 1 && curs[0] !== "") {
          rows.push([b.brand, b.ios, minorToMajor(b.total_minor), curs[0], b.first_start ?? "", b.last_end ?? "", b.active, b.screens.join(" | "), b.agencies.join(" | ")]);
        } else if (curs.length === 1) {
          rows.push([b.brand, b.ios, minorToMajor(b.total_minor), "", b.first_start ?? "", b.last_end ?? "", b.active, b.screens.join(" | "), b.agencies.join(" | ")]);
        } else {
          for (const c of curs) {
            rows.push([b.brand, b.ios, minorToMajor(b.totals_by_currency[c] ?? 0), c, b.first_start ?? "", b.last_end ?? "", b.active, b.screens.join(" | "), b.agencies.join(" | ")]);
          }
        }
      }
      return csv(
        `marcas-${stamp}.csv`,
        ["marca", "pedidos", "inversion_mayor", "moneda", "primera_pauta", "ultima_pauta", "activa", "pantallas", "agencias"],
        rows,
      );
    }

    // orders
    if (entity === "orders") {
    const { ORDER_STAGES } = await import("@/lib/orders-db");
    const BILLINGS: readonly string[] = ["sin_facturar", "facturado", "parcial", "pagado", "vencido"];
    const stageRaw = sp.get("stage") ?? sp.get("etapa");
    const billingRaw = sp.get("billing") ?? sp.get("cobro");
    const stage = (ORDER_STAGES as readonly string[]).includes(stageRaw ?? "") ? (stageRaw as string) : null;
    const billing = BILLINGS.includes(billingRaw ?? "") ? (billingRaw as string) : null;
    const { listOrders } = await import("@/lib/orders-db");
    type ListOpts = NonNullable<Parameters<typeof listOrders>[1]>;
    const list = await listOrders(storeId, {
      q,
      stage: stage as ListOpts["stage"],
      billing: billing as ListOpts["billing"],
    });
    // listOrders topa en 200 (volumen bajo, sin paginación exacta que mentir).
    const ordersTruncated = list.length >= 200;
    const rows = list.map((o) => [
      o.io_number,
      o.brand ?? "",
      o.status,
      o.stage,
      o.billing,
      o.advertiser_name ?? "",
      o.billing_name ?? "",
      o.starts_at ?? "",
      o.ends_at ?? "",
      o.lines_count,
      minorToMajor(o.gross_minor),
      minorToMajor(o.invoiced_minor),
      minorToMajor(o.paid_minor),
      minorToMajor(o.pending_minor),
      o.currency,
    ]);
    return csv(
      `ordenes-${stamp}.csv`,
      ["orden", "marca", "estado", "etapa", "cobro", "anunciante", "facturacion", "inicio", "fin", "lineas", "bruto_mayor", "facturado_mayor", "pagado_mayor", "pendiente_mayor", "moneda"],
      rows,
      { truncated: ordersTruncated },
    );
    }

    // screens (inventario; price_pen ya va en soles mayor)
    {
      const { listScreens, parseScreensSort } = await import("@/lib/screens-db");
      const supplierId = (sp.get("proveedor") ?? sp.get("supplier") ?? "").trim() || null;
      const city = (sp.get("ciudad") ?? sp.get("city") ?? "").trim() || null;
      const estadoRaw = (sp.get("estado") ?? sp.get("active") ?? "").trim();
      const active = estadoRaw === "active" || estadoRaw === "activas" ? "active" : estadoRaw === "inactive" || estadoRaw === "inactivas" ? "inactive" : "all";
      const { key, dir } = parseScreensSort({ sort: sp.get("sort") ?? undefined, dir: sp.get("dir") ?? undefined });
      const rows: CsvCell[][] = [];
      const PAGE = 100;
      for (let page = 1; page <= 20; page += 1) {
        const res = await listScreens(storeId, { q, supplierId, city, active: active as "all" | "active" | "inactive", sortKey: key, sortDir: dir, page, pageSize: PAGE });
        for (const s of res.rows) {
          rows.push([s.id, s.name, s.external_ref ?? "", s.supplier_name ?? "", s.venue_name ?? "", s.district ?? "", s.city ?? "", s.is_active, s.width_m ?? "", s.height_m ?? "", s.width_px ?? "", s.height_px ?? "", s.price_pen ?? "", s.impact_day ?? "", s.impressions_day ?? ""]);
        }
        if (res.rows.length < PAGE || rows.length >= res.total) break;
      }
      return csv(
        `pantallas-${stamp}.csv`,
        ["id", "pantalla", "codigo", "proveedor", "ubicacion", "distrito", "ciudad", "activa", "ancho_m", "alto_m", "ancho_px", "alto_px", "precio_pen", "impactos_dia", "impresiones_dia"],
        rows,
      );
    }
  } catch (e) {
    console.error("[export]", e instanceof Error ? e.message : e);
    return new Response("No se pudo generar el CSV.", { status: 500 });
  }
}

function safeFilename(name: string): string {
  // Allowlist: evita CRLF/quotes/path en content-disposition.
  // Hoy el caller pasa `entidad-YYYY-MM-DD.csv` (seguro), pero el helper
  // no debe interpolar `entity`/`q` sin sanitizar en el futuro.
  const base = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "export.csv";
  return base.endsWith(".csv") ? base : `${base}.csv`;
}

function csv(filename: string, headers: string[], rows: CsvCell[][], opts?: { truncated?: boolean }) {
  const safe = safeFilename(filename);
  const body = `\uFEFF${toCsv(headers, rows)}`;
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`,
      "cache-control": "no-store",
      ...(opts?.truncated ? { "X-Export-Truncated": "1" } : {}),
    },
  });
}
