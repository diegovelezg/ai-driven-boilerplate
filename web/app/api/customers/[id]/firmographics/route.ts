import { loadCustomerFirmographics } from "@/lib/customer-data";
import { resolveRouteCustomerId } from "@/lib/api/guard";

export type { CustomerFirmographics } from "@/lib/customer-data";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const idOrErr = await resolveRouteCustomerId(params);
  if (idOrErr instanceof Response) return idOrErr;
  const id = idOrErr;

  const result = await loadCustomerFirmographics(id);
  if (!result) return Response.json({ error: "Customer no encontrado." }, { status: 404 });
  return Response.json(result);
}
