// SSOT de factory de rutas chat 501 (issue #8 P2).
// Las 5 rutas chat (chat + companies/contacts/orders/[id] + brands/[name])
// comparten el mismo esqueleto en pausa (Fase 2: agente DOOH en construcción).
// Un solo factory; cada route.ts solo hace `export const POST = createChatRoute()`.
// Cuando aterrice el agente, la lógica real vive aquí y las rutas no se tocan.
export function createChatRoute(message = "Chat en pausa (Fase 2: agente DOOH en construcción).") {
  return async function POST(_req: Request, _ctx?: { params: Promise<unknown> }) {
    return Response.json({ error: message }, { status: 501 });
  };
}
