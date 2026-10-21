// Solo server-side: usa service_role (bypassa RLS). Nunca importar en client components.
// (Sin `import "server-only"`: los tests `tsx --test` importan este módulo en
// node y `server-only` lanza fuera de React Server Components. La protección
// real contra fugas al browser es no serializar secretos: ver `toSafeConnections`.)
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { WebSocket as WsPolyfill } from "ws";

let cached: SupabaseClient | null = null;

export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function getSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Falta SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en .env.local");
  }
  if (!cached) {
    // WebSocket global: Node <22 no lo trae y realtime-js de supabase-js
    // LANZA en `createClient` tumbando el worker/scheduled-task en silencio
    // (exit 0 sin `start`). Next y browsers ya lo tienen: solo se polifilea
    // cuando falta (red de seguridad aunque la imagen ya sea node:22).
    if (typeof globalThis.WebSocket === "undefined") {
      globalThis.WebSocket = WsPolyfill as unknown as typeof WebSocket;
    }
    // Sin timeout un Supabase colgado deja server actions colgadas para
    // siempre (botón atascado, sin toast): fetch global con deadline de 60s.
    cached = createClient(url, key, {
      auth: { persistSession: false },
      global: {
        fetch: (input, init) =>
          fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(60_000) }),
      },
    });
  }
  return cached;
}
