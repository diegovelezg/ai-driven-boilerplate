// Comunes de las rutas POST de research (brands/:name + companies/:id):
// rate-limit por tenant y parseo tolerante del body {domains, force}.
// El resto (candidatos, loop de `researchDomain`) diverge por entidad y se
// queda en cada route.

/** 429 si el tenant excede 12 investigaciones/minuto (mismo mensaje). */
export async function checkResearchRateLimit(kind: "brand" | "company", storeId: string): Promise<Response | null> {
  const { checkRateLimit } = await import("@/lib/rate-limit");
  if (!checkRateLimit(`research:${kind}:${storeId}`, 12, 60_000)) {
    return Response.json({ error: "Demasiadas investigaciones. Espera un momento." }, { status: 429 });
  }
  return null;
}

/** Body `{domains, force}` tolerante (sin body o JSON roto → defaults). */
export async function parseResearchBody(req: Request): Promise<{ domains?: unknown; force?: unknown }> {
  try {
    return (await req.json()) as { domains?: unknown; force?: unknown };
  } catch {
    return {};
  }
}
