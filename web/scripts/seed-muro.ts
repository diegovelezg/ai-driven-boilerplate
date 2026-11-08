// Seed del muro (issue #11): 5 posts demo para ver el layout del inbox.
// Uso: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/seed-muro.ts
// Idempotente: borra los demo previos (audience_json.demo=true) y reinserta 5.
import { getSupabase } from "@/lib/supabase";
import { fail, loadStoreId } from "./lib/run-once";

async function main(): Promise<void> {
  const db = getSupabase();
  const storeId = await loadStoreId();
  console.log(`[muro] store=${storeId}`);

  const { data: prev } = await db.from("sys_insights").select("id,audience_json").eq("store_id", storeId);
  const demoIds = ((prev ?? []) as Array<Record<string, unknown>>)
    .filter((r) => (r.audience_json as Record<string, unknown> | null)?.demo === true)
    .map((r) => String(r.id));
  if (demoIds.length > 0) {
    await db.from("sys_insights").delete().in("id", demoIds);
    console.log(`[muro] demos previos borrados: ${demoIds.length}`);
  }

  const { data: order } = await db
    .from("io_orders")
    .select("id,io_number,brand,starts_at,ends_at,currency,advertiser_company_id")
    .eq("store_id", storeId)
    .neq("status", "cancelled")
    .order("starts_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const o = order as Record<string, unknown> | null;
  const orderId = o ? String(o.id) : null;
  const orderNum = o ? String(o.io_number ?? "SM-2026-0007") : "SM-2026-0007";
  const orderLink = orderId ? `/orders?order=${orderId}` : "/orders";
  let orderCtx: Record<string, unknown> | null = null;
  if (o) {
    const advId = (o.advertiser_company_id as string | null) ?? null;
    let company: string | null = null;
    if (advId) {
      const { data: co } = await db.from("crm_companies").select("name").eq("id", advId).maybeSingle();
      company = co ? String((co as Record<string, unknown>).name ?? "") || null : null;
    }
    let screens: number | null = null;
    if (orderId) {
      const { data: lines } = await db.from("io_lines").select("screen_id").eq("store_id", storeId).eq("io_id", orderId).limit(500);
      const uniq = new Set(((lines ?? []) as Array<Record<string, unknown>>).map((l) => String(l.screen_id)));
      screens = uniq.size > 0 ? uniq.size : null;
    }
    orderCtx = {
      company,
      brand: (o.brand as string | null) ?? null,
      screens,
      amountMinor: null,
      currency: (o.currency as string | null) ?? null,
      startsAt: (o.starts_at as string | null) ?? null,
      endsAt: (o.ends_at as string | null) ?? null,
    };
  } else {
    // Sin OIs en la DB local: contexto demo explícito para ver la card humana.
    orderCtx = {
      company: "Alicorp",
      brand: "Tottus",
      screens: 3,
      amountMinor: 420000,
      currency: "PEN",
      startsAt: "2026-11-10",
      endsAt: "2026-11-30",
    };
  }
  const aud = { user_ids: [], emails: [], roles: ["seller", "admin"], demo: true } as const;
  const audAll = { user_ids: [], emails: [], roles: [], demo: true } as const;

  const rows = [
    {
      store_id: storeId,
      kind: "sin_om",
      title: `Falta OM: no se puede facturar · ${orderNum}`,
      body: `Empezó hace 2d y sigue sin OM — no se puede facturar. Acción: registrar el OM en ${orderLink}.`,
      links_json: [orderLink],
      audience_json: { ...aud },
      severity: "critical",
      scope_kind: "order",
      scope_id: orderId,
      context_json: orderCtx,
    },
    {
      store_id: storeId,
      kind: "material",
      title: `Material sin aprobar · ${orderNum}`,
      body: `Al aire con material sin aprobar (QC/legal). Acción: aprobar creatividades en ${orderLink}.`,
      links_json: [orderLink],
      audience_json: { ...audAll },
      severity: "warning",
      scope_kind: "order",
      scope_id: orderId,
      context_json: orderCtx,
    },
    {
      store_id: storeId,
      kind: "por_certificar",
      title: "Terminadas sin certificar · 3",
      body: "3 orden(es) terminada(s) sin foto-check — riesgo de disputa al cobrar. Acción: abrir /orders.",
      links_json: ["/orders"],
      audience_json: { ...audAll },
      severity: "warning",
      scope_kind: "global",
      scope_id: null,
      context_json: {
        metrics: [
          { label: "En riesgo", value: "3 OIs" },
          { label: "Esperando", value: "12d (la más antigua)" },
          { label: "Monto", value: "S/ 8.400" },
        ],
      },
    },
    {
      store_id: storeId,
      kind: "ocupacion",
      title: "Ocupación 14d · 42%",
      body: "42 de 100 pantalla-día vendidos en 14d. Acción: revisar huecos en /screens.",
      links_json: ["/screens"],
      audience_json: { ...audAll },
      severity: "info",
      scope_kind: "global",
      scope_id: null,
      context_json: {
        metrics: [
          { label: "Vendidos", value: "42 de 100" },
          { label: "Libres", value: "58 pantalla-día" },
          { label: "Mayor hueco", value: "Óvalo Gutiérrez · 9d" },
          { label: "Ventana", value: "08/11 → 22/11" },
        ],
      },
    },
    {
      store_id: storeId,
      kind: "huecos",
      title: "Huecos · 21d libres (top 3)",
      body: "Óvalo Gutiérrez 9d · Larco 7d · Arequipa 5d. Acción: ofrecerlos en /screens.",
      links_json: ["/screens"],
      audience_json: { ...audAll },
      severity: "info",
      scope_kind: "global",
      scope_id: null,
      context_json: {
        metrics: [
          { label: "Días libres", value: "21d (top 3)" },
          { label: "Con hueco", value: "3 de 8" },
          { label: "Ventana", value: "próximos 14d" },
        ],
      },
    },
  ];
  const { error } = await db.from("sys_insights").insert(rows);
  if (error) throw new Error(`Insights insert: ${error.message}`);
  console.log(`[muro] 5 demos insertados (1 @sellers+admin, 4 globales).`);
}

main().catch((e) => fail("MURO", e));
