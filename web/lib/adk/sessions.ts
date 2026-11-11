import { InMemorySessionService } from "@google/adk";

// Singleton de sesiones en memoria para el chat HTTP.
// Válido con una sola instancia web. Si se escala a
// múltiples réplicas, migrar a DatabaseSessionService (Supabase) sin cambiar callers.
let svc: InMemorySessionService | null = null;

export function getChatSessionService(): InMemorySessionService {
  if (!svc) svc = new InMemorySessionService();
  return svc;
}
