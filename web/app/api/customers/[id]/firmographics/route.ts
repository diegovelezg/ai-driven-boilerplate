import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { classifyDomain, domainFromEmail, type DomainType } from "@/lib/domains";

export interface CustomerFirmographics {
  domain: string;
  domainType: DomainType | "none";
  enrichable: boolean;
  enriched: boolean;
  companyName: string | null;
  industry: string | null;
  description: string | null;
  size: string | null;
  location: string | null;
  logoUrl: string | null;
  sourceUrl: string | null;
  confidence: number | null;
  enrichedAt: string | null;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isSupabaseConfigured()) {
    return Response.json({ error: "Supabase no configurado." }, { status: 500 });
  }
  const { id } = await params;
  if (!id) return Response.json({ error: "Falta id." }, { status: 400 });

  const db = getSupabase();
  const { data: customer, error } = await db
    .from("customers")
    .select("email")
    .eq("id", id)
    .maybeSingle();
  if (error || !customer) {
    return Response.json({ error: "Customer no encontrado." }, { status: 404 });
  }

  const domain = domainFromEmail(String(customer.email ?? ""));
  const cls = classifyDomain(domain);
  const base: CustomerFirmographics = {
    domain,
    domainType: cls.type,
    enrichable: cls.enrichable,
    enriched: false,
    companyName: null,
    industry: null,
    description: null,
    size: null,
    location: null,
    logoUrl: null,
    sourceUrl: null,
    confidence: null,
    enrichedAt: null,
  };
  if (!cls.enrichable) return Response.json(base);

  const { data: row } = await db
    .from("domains")
    .select("*")
    .eq("domain", domain)
    .maybeSingle();
  if (!row) return Response.json(base);

  return Response.json({
    ...base,
    enriched: true,
    companyName: (row.company_name as string) ?? null,
    industry: (row.industry as string) ?? null,
    description: (row.description as string) ?? null,
    size: (row.size as string) ?? null,
    location: (row.location as string) ?? null,
    logoUrl: (row.logo_url as string) ?? null,
    sourceUrl: (row.source_url as string) ?? null,
    confidence: row.confidence == null ? null : Number(row.confidence),
    enrichedAt: (row.enriched_at as string) ?? null,
  });
}
