import { getSupabase } from "@/lib/supabase";
import { requireCustomerStoreAccess, resolveRouteCustomerId } from "@/lib/api/guard";
import { HORIZON_BY_ARCHETYPE } from "@/lib/retention-model";

// Issue #19 Paso 5: historial de contactos por cliente (¿ya le escribimos?).
// Patrón de /prediction: el drawer solo consume el DTO, nunca la DB.
export interface CustomerContactDTO {
  id: string;
  channel: string;
  subject: string | null;
  body: string;
  status: string;
  createdAt: string;
  dispatchedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  /** Primera compra posterior dentro de la ventana del analyst (H). */
  result: { boughtAt: string; amountMinor: number; currency: string | null } | null;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const idOrErr = await resolveRouteCustomerId(params);
  if (idOrErr instanceof Response) return idOrErr;
  const id = idOrErr;
  const access = await requireCustomerStoreAccess(id);
  if (access instanceof Response) return access;
  const db = getSupabase();
  const { data: cust } = await db
    .from("customers")
    .select("store_id")
    .eq("id", id)
    .maybeSingle();
  if (!cust) return Response.json({ error: "Customer no encontrado." }, { status: 404 });
  const storeId = String(cust.store_id ?? "");

  // Ventana del analyst: H por arquetipo de la tienda (default 14d).
  let windowDays = 14;
  try {
    const { getStoreProfile } = await import("@/lib/store-profiles");
    const profile = await getStoreProfile(storeId).catch(() => null);
    if (profile) windowDays = HORIZON_BY_ARCHETYPE[profile.archetype] ?? 14;
  } catch {
    windowDays = 14;
  }

  const selectCols = (withApprover: boolean) =>
    `id,channel,subject,body,status,created_at,dispatched_at,revenue_attributed${withApprover ? ",approved_by,approved_at" : ""}`;
  // Fallback sin approved_by/at si la migración 20261022000000 aún no corrió.
  let res = await db
    .from("proposed_actions")
    .select(selectCols(true))
    .eq("customer_id", id)
    .in("status", ["dispatched", "approved", "pending_review", "rejected"])
    .order("created_at", { ascending: false })
    .limit(50);
  if (res.error) {
    res = await db
      .from("proposed_actions")
      .select(selectCols(false))
      .eq("customer_id", id)
      .in("status", ["dispatched", "approved", "pending_review", "rejected"])
      .order("created_at", { ascending: false })
      .limit(50);
  }
  if (res.error) {
    return Response.json({ error: res.error.message }, { status: 500 });
  }
  const rows = (res.data ?? []) as unknown as Array<Record<string, unknown>>;

  const contacts: CustomerContactDTO[] = [];
  for (const r of rows) {
    const dispatchedAt = (r.dispatched_at as string | null) ?? null;
    let result: CustomerContactDTO["result"] = null;
    if (dispatchedAt) {
      const end = new Date(Date.parse(dispatchedAt) + windowDays * 86_400_000).toISOString();
      const { data: ord } = await db
        .from("orders")
        .select("total_amount,placed_at,currency")
        .eq("store_id", storeId)
        .eq("customer_id", id)
        .gt("placed_at", dispatchedAt)
        .lte("placed_at", end)
        .order("placed_at", { ascending: true })
        .limit(1);
      const o = ((ord ?? []) as Array<Record<string, unknown>>)[0];
      if (o) {
        result = {
          boughtAt: String(o.placed_at ?? "").slice(0, 10),
          amountMinor: Number(o.total_amount ?? 0),
          currency: (o.currency as string | null) ?? null,
        };
      }
    }
    contacts.push({
      id: String(r.id ?? ""),
      channel: String(r.channel ?? ""),
      subject: (r.subject as string | null) ?? null,
      body: String(r.body ?? ""),
      status: String(r.status ?? ""),
      createdAt: String(r.created_at ?? ""),
      dispatchedAt,
      approvedBy: (r.approved_by as string | null) ?? null,
      approvedAt: (r.approved_at as string | null) ?? null,
      result,
    });
  }
  return Response.json({ contacts, windowDays });
}
