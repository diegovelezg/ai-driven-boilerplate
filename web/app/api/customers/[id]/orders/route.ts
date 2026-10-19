import { loadCustomerOrdersAndRfm } from "@/lib/customer-data";
import { requireCustomerStoreAccess, resolveRouteCustomerId } from "@/lib/api/guard";

export type {
  CustomerOrder,
  CustomerRfm,
} from "@/lib/customer-data";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const idOrErr = await resolveRouteCustomerId(params);
  if (idOrErr instanceof Response) return idOrErr;
  const id = idOrErr;
  const access = await requireCustomerStoreAccess(id);
  if (access instanceof Response) return access;

  const result = await loadCustomerOrdersAndRfm(id);
  if (!result) return Response.json({ error: "Customer no encontrado." }, { status: 404 });
  return Response.json(result);
}
