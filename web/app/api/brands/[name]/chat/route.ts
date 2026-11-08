// Chat del drawer de marca: paridad con /api/companies/[id]/chat.
// Fase 2: agente DOOH en construcción (501 honesto hasta que aterrice).
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  void name;
  return Response.json({ error: "Chat en pausa (Fase 2: agente DOOH en construcción)." }, { status: 501 });
}
