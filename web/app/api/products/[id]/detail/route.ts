import { requireApiUser, requireStoreMember, resolveRouteCustomerId } from "@/lib/api/guard";
import { loadProductDetail } from "@/lib/product-detail";

export type { ProductDetailDTO } from "@/lib/product-detail";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const idOrErr = await resolveRouteCustomerId(params);
  if (idOrErr instanceof Response) return idOrErr;
  let result: Awaited<ReturnType<typeof loadProductDetail>>;
  try {
    result = await loadProductDetail(idOrErr);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "DB read failed." }, { status: 500 });
  }
  if (!result) return Response.json({ error: "Producto no encontrado." }, { status: 404 });
  const auth = await requireApiUser();
  if (auth instanceof Response) return auth;
  const denied = await requireStoreMember(result.storeId, auth);
  if (denied) return denied;
  return Response.json(result.dto);
}
