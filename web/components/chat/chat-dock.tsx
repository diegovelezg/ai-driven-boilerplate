"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { X } from "lucide-react";
import type { ChatArtifact } from "./types";
import { ChatPanel } from "./chat-panel";

export interface ChatDockState {
  storeId: string;
  storeName: string;
  marketId: string | null;
}

interface ChatDockContextValue {
  dock: ChatDockState | null;
  /** Abre (o reemplaza) el dock con tienda explícita. Sin foco: el
   *  orquestador rutea solo. */
  openDock: (input: {
    storeId: string;
    storeName: string;
    marketId?: string | null;
  }) => void;
  /** Toggle desde el icono del sidebar: cierra si está abierto; si no,
   *  abre heredando tienda/market de la URL. */
  toggleChat: () => void;
  closeDock: () => void;
}

const ChatDockContext = createContext<ChatDockContextValue | null>(null);

export function useChatDock(): ChatDockContextValue {
  const ctx = useContext(ChatDockContext);
  if (!ctx) throw new Error("useChatDock debe usarse dentro de ChatDockProvider.");
  return ctx;
}

/** Estado global del dock: vive en el layout del dashboard para que el chat
 *  quede anclado a la izquierda y la vista actual a la derecha. */
export function ChatDockProvider({
  stores,
  children,
}: {
  /** Tiendas para resolver el toggle del sidebar ({id, label} ya calculado en servidor). */
  stores: Array<{ id: string; label: string }>;
  children: ReactNode;
}) {
  const [dock, setDock] = useState<ChatDockState | null>(null);

  const openDock = useCallback<ChatDockContextValue["openDock"]>((input) => {
    setDock({
      storeId: input.storeId,
      storeName: input.storeName,
      marketId: input.marketId ?? null,
    });
  }, []);

  const closeDock = useCallback(() => setDock(null), []);

  const toggleChat = useCallback(() => {
    if (dock) {
      setDock(null);
      return;
    }
    const sp = new URLSearchParams(window.location.search);
    const requested = sp.get("store");
    const store = stores.find((s) => s.id === requested) ?? stores[0] ?? null;
    if (!store) return;
    setDock({
      storeId: store.id,
      storeName: store.label,
      marketId: sp.get("market"),
    });
  }, [dock, stores]);

  return (
    <ChatDockContext.Provider value={{ dock, openDock, toggleChat, closeDock }}>
      {children}
    </ChatDockContext.Provider>
  );
}

/** Fila del dashboard: dock de chat a la izquierda (sticky) + página a la derecha.
 *  El contenido no se tapa ni se desmonta; solo se estrecha. */
export function DashboardShell({ children }: { children: ReactNode }) {
  const { dock, closeDock } = useChatDock();

  return (
    <div className="flex w-full items-start">
      {dock && <DockRoot dock={dock} onClose={closeDock} />}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Raíz del dock: chat fijo a la izquierda (420px) + página a la derecha.
 *  Pedir ver datos NO crea tarjetas paralelas: navega la derecha al Review
 *  real filtrado a esos IDs (misma página, mismos botones). */
function DockRoot({ dock, onClose }: { dock: ChatDockState; onClose: () => void }) {
  const router = useRouter();
  const pathname = usePathname();

  /** Artefacto de lista → la derecha muestra el Review filtrado.
   *  Misma ruta: replace (sin spam de historial). Otra ruta: push.
   *  Lo último pedido manda (reemplaza filtros anteriores del chat). */
  const handleArtifact = useCallback(
    (artifact: ChatArtifact | null) => {
      if (!artifact) {
        // Conversación limpia: quita el filtro del chat si la
        // derecha es Review. Al cerrar el dock no se toca nada.
        // (Los filtros de Customers son también humanos: nunca se limpian solos.)
        if (pathname === "/review") {
          const sp = new URLSearchParams(window.location.search);
          if (sp.has("actionIds") || sp.has("leadIds") || sp.has("signalIds")) {
            sp.delete("actionIds");
            sp.delete("leadIds");
            sp.delete("signalIds");
            const qs = sp.toString();
            router.replace(qs ? `/review?${qs}` : "/review");
          }
        }
        return;
      }
      // Filtro de Customers: escribe los params de la tabla (los mismos que
      // los filtros humanos) y la vista obedece. Sin tarjetas paralelas.
      if (artifact.tool === "filter_customers") {
        const d = (artifact.data ?? {}) as {
          filter?: { q?: string | null; decision?: string | null; vista?: string | null; ritmo?: string | null };
        };
        const f = d.filter ?? {};
        const qs = new URLSearchParams();
        if (dock.marketId) qs.set("market", dock.marketId);
        if (f.q) qs.set("q", f.q);
        if (f.decision) qs.set("decision", f.decision);
        if (f.vista) qs.set("vista", f.vista);
        if (f.ritmo) qs.set("ritmo", f.ritmo);
        const href = `/customers?${qs.toString()}`;
        if (pathname === "/customers") router.replace(href);
        else router.push(href);
        return;
      }
      const param =
        artifact.tool === "list_actions"
          ? "actionIds"
          : artifact.tool === "list_leads"
            ? "leadIds"
            : null;
      if (!param) return;
      const ids = rowsOfArtifact(artifact).slice(0, 20);
      if (ids.length === 0) return;
      const qs = new URLSearchParams();
      if (dock.marketId) qs.set("market", dock.marketId);
      qs.set(param, ids.join(","));
      const href = `/review?${qs.toString()}`;
      if (pathname === "/review") router.replace(href);
      else router.push(href);
    },
    [dock.marketId, pathname, router],
  );

  return (
    <>
      <button
        type="button"
        aria-label="Cerrar chat"
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default bg-black/40 md:hidden"
      />
      <aside
        aria-label="Chat"
        className="fixed inset-y-0 left-0 z-50 flex w-[min(420px,94vw)] flex-col border-r bg-background md:sticky md:top-12 md:h-[calc(100dvh-3rem)] md:w-[420px] md:shrink-0"
      >
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-start justify-between gap-2 border-b px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold tracking-tight">Pregunta a tu equipo de agentes</p>
              </div>
              <div className="flex shrink-0 items-center">
                <button
                  type="button"
                  onClick={onClose}
                  title="Cerrar chat"
                  aria-label="Cerrar chat"
                  className="rounded p-1.5 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <X className="size-4" aria-hidden />
                </button>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              <ChatPanel
                storeId={dock.storeId}
                marketId={dock.marketId}
                onArtifact={handleArtifact}
              />
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}

/** IDs de las filas del artefacto (cap 20): el filtro exacto del Review. */
function rowsOfArtifact(artifact: ChatArtifact): string[] {
  const d = artifact.data as { results?: unknown } | unknown[] | Record<string, unknown>;
  const raw = Array.isArray(d) ? d : (d as { results?: unknown })?.results;
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const r of raw) {
    const id = (r as Record<string, unknown>)?.id;
    if (typeof id === "string" && id) ids.push(id);
    if (ids.length >= 20) break;
  }
  return ids;
}
