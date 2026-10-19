import { getSupabase } from "@/lib/supabase";
import { requireCustomerStoreAccess, resolveRouteCustomerId } from "@/lib/api/guard";

interface CustomerPredictionDTO {
  model: string;
  pRecompraH: number | null;
  pLow: number | null;
  pHigh: number | null;
  horizonDays: number | null;
  expectedDays: number | null;
  p25Days: number | null;
  p75Days: number | null;
  ticketEsperadoMinor: number | null;
  valorEsperadoMinor: number | null;
  currency: string | null;
  decision: string;
  confidence: string;
  asOf: string | null;
  tDays: number | null;
  cycleDays: number | null;
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
  const { data: pred } = await db
    .from("customer_predictions")
    .select(
      "model,p_recompra_h,p_low,p_high,horizon_days,expected_days,p25_days,p75_days,ticket_esperado_minor,valor_esperado_minor,currency,decision,confidence,as_of,evidence_json",
    )
    .eq("customer_id", id)
    .order("as_of", { ascending: false })
    .order("model_version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!pred) return Response.json({ prediction: null });
  const ev = (pred.evidence_json as Record<string, unknown> | null) ?? {};
  const dto: CustomerPredictionDTO = {
    model: String(pred.model ?? ""),
    pRecompraH: pred.p_recompra_h == null ? null : Number(pred.p_recompra_h),
    pLow: pred.p_low == null ? null : Number(pred.p_low),
    pHigh: pred.p_high == null ? null : Number(pred.p_high),
    horizonDays: pred.horizon_days == null ? null : Number(pred.horizon_days),
    expectedDays: pred.expected_days == null ? null : Number(pred.expected_days),
    p25Days: pred.p25_days == null ? null : Number(pred.p25_days),
    p75Days: pred.p75_days == null ? null : Number(pred.p75_days),
    ticketEsperadoMinor:
      pred.ticket_esperado_minor == null ? null : Number(pred.ticket_esperado_minor),
    valorEsperadoMinor:
      pred.valor_esperado_minor == null ? null : Number(pred.valor_esperado_minor),
    currency: (pred.currency as string | null) ?? null,
    decision: String(pred.decision ?? ""),
    confidence: String(pred.confidence ?? ""),
    asOf: (pred.as_of as string | null) ?? null,
    tDays: ev.t_days == null ? null : Number(ev.t_days),
    cycleDays: ev.cycle_days == null ? null : Number(ev.cycle_days),
  };
  return Response.json({ prediction: dto });
}
