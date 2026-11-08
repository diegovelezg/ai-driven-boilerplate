import { listDistinctJobTitles } from "@/lib/crm-db";
import { requireApiUser, requireStoreMember } from "@/lib/api/guard";
import { resolveActiveStoreId } from "@/lib/tenant";

/**
 * GET /api/contacts/job-titles — cargos distintos ya usados (autocomplete).
 * Evita repetir cargos con distinta escritura.
 */
export async function GET() {
  const auth = await requireApiUser();
  if (auth instanceof Response) return auth;
  try {
    const storeId = await resolveActiveStoreId();
    if (!storeId) return Response.json({ error: "Sin tienda." }, { status: 400 });
    const denied = await requireStoreMember(storeId, auth);
    if (denied) return denied;
    const job_titles = await listDistinctJobTitles(storeId);
    return Response.json({ job_titles });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "DB read failed." }, { status: 500 });
  }
}
