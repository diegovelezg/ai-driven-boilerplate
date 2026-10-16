import { isSupabaseConfigured } from "@/lib/supabase";
import { loadCustomerFirmographics } from "@/lib/customer-data";

export type { CustomerFirmographics } from "@/lib/customer-data";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isSupabaseConfigured()) {
    return Response.json({ error: "Supabase no configurado." }, { status: 500 });
  }
  const { id } = await params;
  if (!id) return Response.json({ error: "Falta id." }, { status: 400 });

  const result = await loadCustomerFirmographics(id);
  if (!result) return Response.json({ error: "Customer no encontrado." }, { status: 404 });
  return Response.json(result);
}
