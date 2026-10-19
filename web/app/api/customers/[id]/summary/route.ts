import { getSupabase } from "@/lib/supabase";
import { requireCustomerStoreAccess, resolveRouteCustomerId } from "@/lib/api/guard";
import { toEditableCustomer } from "@/lib/customers-db";
import { domainFromEmail } from "@/lib/domains";

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
  const { data, error } = await db.from("customers").select("*").eq("id", id).maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!data) return Response.json({ error: "Customer no encontrado." }, { status: 404 });

  const r = data as Record<string, unknown>;
  const domain = domainFromEmail(String(r.email ?? ""));
  let enriched = new Map<string, string>();
  if (domain) {
    const { data: d } = await db.from("domains").select("domain,company_name").eq("domain", domain).maybeSingle();
    const name = (d?.company_name as string | undefined) ?? null;
    if (name) enriched = new Map([[domain, name]]);
  }
  return Response.json({ customer: toEditableCustomer(r, enriched) });
}
