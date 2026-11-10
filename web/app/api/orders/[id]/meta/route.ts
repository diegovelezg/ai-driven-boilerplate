import { getSupabase } from "@/lib/supabase";
import { toContactRef } from "@/lib/orders-db";
import { requireRouteEntity } from "@/lib/api/guard";

/** GET /api/orders/:id/meta — agencias + contactos para el editor de ficha.
 *  Separado del detalle (perf 2026-11-09): el drawer abre sin estos datos
 *  (hasta 200+200 filas); el editor los pide al montar. Mismo guard que el
 *  detalle: 404 idéntico sin membresía (nunca 403 oráculo). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const loaded = await requireRouteEntity(
      "io_orders",
      id,
      "store_id,billing_company_id,advertiser_company_id,agency_company_id",
      "Orden no encontrada.",
    );
    if (loaded instanceof Response) return loaded;
    const { storeId, row: o } = loaded;
    const db = getSupabase();
    // Agencias del tenant para vincular intermediaria (Opción B) + % default.
    const { data: agencies } = await db
      .from("crm_companies")
      .select("id,name,tax_id,agency_commission_pct")
      .eq("store_id", storeId)
      .eq("kind", "agencia")
      .order("name", { ascending: true })
      .limit(200);
    // Contactos de las empresas del caso (facturador + anunciante +
    // intermediaria) para los pickers de POC/firmante/pago/responsable.
    const caseCompanyIds = [...new Set(
      [o.billing_company_id, o.advertiser_company_id, o.agency_company_id]
        .filter((x): x is string => typeof x === "string" && !!x),
    )];
    let orderContacts: ReturnType<typeof toContactRef>[] = [];
    if (caseCompanyIds.length > 0) {
      const { data: contacts } = await db
        .from("crm_contacts")
        .select("id,company_id,first_name,last_name,email,phone,job_title,is_primary,crm_companies!contacts_company_id_fkey(name)")
        .eq("store_id", storeId)
        .in("company_id", caseCompanyIds)
        .order("is_primary", { ascending: false })
        .order("created_at", { ascending: true })
        .limit(200);
      orderContacts = ((contacts ?? []) as Array<Record<string, unknown>>).map(toContactRef);
    }
    return Response.json({
      order_contacts: orderContacts,
      agencies: ((agencies ?? []) as Array<Record<string, unknown>>).map((a) => ({
        id: String(a.id),
        name: String(a.name ?? ""),
        tax_id: typeof a.tax_id === "string" && a.tax_id.trim() ? a.tax_id.trim() : null,
        commission_pct: Number.isFinite(Number(a.agency_commission_pct)) ? Number(a.agency_commission_pct) : null,
      })),
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "DB read failed." }, { status: 500 });
  }
}
