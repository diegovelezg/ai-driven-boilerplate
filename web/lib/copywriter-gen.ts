// Sello de criterios del copywriter: los borradores sin este sello son de
// criterios viejos (v1 implícita, v2 plantilla) y se pueden regenerar. Módulo
// neutro (sin imports server) para poder compararlo desde Client Components.
export const COPYWRITER_GEN = "copywriter:v16:identidad-estructural";

/** ¿Este generator cuenta como criterios actuales? (null = v1 implícita). */
export function isFreshGenerator(gen: string | null | undefined): boolean {
  return String(gen ?? "") === COPYWRITER_GEN;
}

/** Formato retention:v1 ("ciclo ~Nd"); lo demás es legacy pre-retention
 *  ("media Nd") o razón ausente. Solo para desglose en mensajes. */
export function isV1SignalReason(reason: string | null | undefined): boolean {
  return /ciclo ~\d+d/i.test(String(reason ?? ""));
}

/** Señales vivas para el auto-refresh (#26): solo estas se re-redactan.
 *  `closed`/`dismissed`/otras nunca se resucitan. */
export const STALE_LIVE_SIGNAL_STATUSES = ["open", "prioritized", "actioned"] as const;

export function isLiveStaleSignalStatus(status: string | null | undefined): boolean {
  return (STALE_LIVE_SIGNAL_STATUSES as readonly string[]).includes(String(status ?? ""));
}

/** Fila mínima de `proposed_actions` para decidir el refresh (sin I/O). */
export interface StaleDraftRow {
  id: string;
  signalId: string | null;
  customerId: string;
  /** `pending_review` es lo único refrescable; el resto nunca se toca. */
  status: string;
  generator: string | null | undefined;
}

/**
 * Selección pura del auto-refresh (#26): stale-solo-pending, señales vivas,
 * límite N, 1 por cliente, nunca approved/dispatched, nunca señales cerradas.
 * Orden determinista por `id` asc. `busySignal`/`busyCustomer` son los frescos
 * (excluyen a los propios stale: el llamador los construye sin los stale).
 * Los huérfanos (sin señal viva) se excluyen: el llamador los purga aparte.
 */
export function selectStaleRefresh(
  drafts: StaleDraftRow[],
  signalStatusById: Map<string, string> | Record<string, string>,
  opts: {
    limit?: number;
    busySignal?: Set<string> | Iterable<string>;
    busyCustomer?: Set<string> | Iterable<string>;
  } = {},
): StaleDraftRow[] {
  const limit = Math.max(0, Math.min(opts.limit ?? 10, 10));
  if (limit === 0) return [];
  const getStatus =
    signalStatusById instanceof Map
      ? (id: string) => signalStatusById.get(id)
      : (id: string) => (signalStatusById as Record<string, string>)[id];
  const busyS = opts.busySignal instanceof Set ? opts.busySignal : new Set(opts.busySignal ?? []);
  const busyC = opts.busyCustomer instanceof Set ? opts.busyCustomer : new Set(opts.busyCustomer ?? []);
  const seenCustomer = new Set<string>();
  const out: StaleDraftRow[] = [];
  const ordered = [...drafts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const d of ordered) {
    if (out.length >= limit) break;
    if (d.status !== "pending_review") continue;
    if (isFreshGenerator(d.generator)) continue;
    const sid = (d.signalId ?? "").trim();
    const cid = (d.customerId ?? "").trim();
    if (!sid || !cid) continue;
    if (busyS.has(sid) || busyC.has(cid)) continue;
    if (seenCustomer.has(cid)) continue;
    const st = getStatus(sid);
    if (!isLiveStaleSignalStatus(st)) continue;
    seenCustomer.add(cid);
    out.push(d);
  }
  return out;
}
