import { listDistinctJobTitles } from "@/lib/crm-db";
import { requireActiveStoreAccess } from "@/lib/api/guard";

/**
 * GET /api/contacts/job-titles — cargos distintos ya usados (autocomplete).
 * Evita repetir cargos con distinta escritura.
 */
export async function GET() {
  const gated = await requireActiveStoreAccess();
  if (gated instanceof Response) return gated;
  const { storeId } = gated;
  try {
    const job_titles = await listDistinctJobTitles(storeId);
    return Response.json({ job_titles });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "DB read failed." }, { status: 500 });
  }
}
