// Ranking único de la mira (SSOT): ordena por valor esperado del motor
// probabilístico (`valor_esperado_minor` desc, desempate `p_recompra_h` desc).
// Sin predicción (tienda sin corrida aún), la fila queda al final ordenada por
// antigüedad (hecho temporal, sinscores ni segmentos).
// Lo consumen Overview, Review, Copywriter y Strategist.
import { getSupabase } from "@/lib/supabase";
import { resolveShopCurrency } from "@/lib/store-profiles";
import { applyScopeFilter, chunkIds, effectiveScopeFilter, isLargeIdScope } from "@/lib/markets";

export interface MiraRow {
  signalId: string;
  customerDbId: string;
  kind: string;
  /** Tratamiento decidido por strategist (winback|nurture|vip_care). Issue #11:
   *  kind = origen detector (scout), objective = tratamiento. */
  objective?: string | null;
  score: number | null;
  /** Motivo crudo del scout (cada vista lo humaniza a su manera). */
  reason: string | null;
  /** Días sin comprar (null = otros tipos de señal). */
  daysSince: number | null;
  status: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  ordersCount: number;
  totalSpent: number;
  /** Moneda primaria del cliente (universo monetario, nunca mezclar). */
  currency: string | null;
  /** ISO2 atribuido (filtro global por mercado; lo escribe el copywriter). */
  country: string | null;
  /** Empresa del cliente (company_name; el brief dossier-first la usa como identidad). */
  companyName: string | null;
  /** Último borrador de la señal (para el CTA correcto en Hoy). */
  draftStatus: "none" | "pending" | "approved" | "dispatched";
  /** Motor probabilístico (opcional para no romper consumidores). */
  pRecompraH?: number | null;
  decision?: string | null;
  expectedDays?: number | null;
  valorEsperadoMinor?: number | null;
  /** Modelo del motor (renovacion|segunda_compra). Issue #11: strategist
   *  decide winback por sesiones/modelo, no por orders_count. */
  model?: string | null;
  /** Veredicto del juez de contactabilidad (issue #16 Fase 1): vive en
   *  `churn_signals.evidence_json.contactability`. `eligible===false` →
   *  la fila no debe ofrecer `Redactar` (veto estable con motivo), salvo
   *  veto vencido (TTL): el contenido cambia a diario y el juez rejuzga. */
  contactability?: { eligible: boolean; reason: string | null; at: string | null } | null;
}

/** TTL del veto del juez (issue #16 P1): pasado este tiempo el veto se
 *  considera vencido y la señal vuelve a ofrecerse para rejuzgar (el
 *  contenido — ferias, promociones, temporada — cambia a diario). */
export const CONTACTABILITY_VETO_TTL_MS = 24 * 60 * 60 * 1000;

/** Extrae el veredicto del juez desde `evidence_json` (null = sin veredicto
 *  o veto vencido). `nowMs` inyectable para tests. */
export function parseContactability(
  ev: Record<string, unknown> | null,
  nowMs: number = Date.now(),
): MiraRow["contactability"] {
  if (!ev) return null;
  const c = ev.contactability as Record<string, unknown> | null | undefined;
  if (!c || typeof c !== "object") return null;
  if (typeof c.eligible !== "boolean") return null;
  const reason = typeof c.reason === "string" && c.reason.trim() ? c.reason.trim().slice(0, 280) : null;
  const at = typeof c.at === "string" && c.at ? c.at : null;
  if (c.eligible === false && at) {
    const ms = Date.parse(at);
    if (!Number.isNaN(ms) && nowMs - ms > CONTACTABILITY_VETO_TTL_MS) return null;
  }
  return { eligible: c.eligible, reason, at };
}

/** Días sin comprar extraídos del motivo crudo (null = otros tipos de señal). */
export function parseDaysSince(raw: string | null): number | null {
  if (!raw) return null;
  const m = raw.match(/sin comprar hace (\d+)d/i) ?? raw.match(/Hace (\d+) días/i);
  return m ? Number(m[1]) : null;
}

/** Ticket medio del cliente (minor units). 0 si sin compras. */
export function avgTicket(totalSpent: number, ordersCount: number): number {
  return ordersCount > 0 ? totalSpent / ordersCount : 0;
}

/**
 * Toda la mira (open + prioritized) rankeada con el criterio único, separada
 * por universo monetario: NUNCA se mezclan PEN con MXN en un mismo ranking ni
 * en una misma suma. `rows` = moneda de la tienda (el ranking principal);
 * `foreign` = otras monedas rankeadas entre sí (no abandonadas, pero aparte).
 *
 * Dos queries simples + join en JS: el ORDER BY score deja empates arbitrarios
 * y el order por join (referencedTable) PostgREST lo ignora en silencio.
 */
export async function getRankedMira(
  storeId: string,
  limit = 100,
  // null = sin filtro de mercado (toda la tienda).
  scope: { countries?: string[] | null; customerIds?: string[] | null; currency?: string | null } | null = null,
): Promise<{ rows: MiraRow[]; foreign: MiraRow[] }> {
  // Filtro global por mercado: ISO2 cortos (nunca miles de IDs en la URL).
  // customerIds solo en el fallback sin países (ver resolveMarketScope).
  // NULL-comodín: señales sin país se ven en todo filtro.
  const db = getSupabase();
  // Issue #11 P1: no truncar por score antes de rankear por valor.
  // Se pagina el universo open+prioritized (no ventana por created_at) y se
  // rankea en memoria por valor_esperado, aplicando limit al final.
  const PAGE = 1000;
  const CAP = 10000;
  const sigs: Array<Record<string, unknown>> = [];
  let sigTruncated = false;
  // Scope fallback grande: rama null una vez + paginado por chunk de IDs
  // (un solo `.in(miles)` revienta la URL). Dedupe por id de señal.
  if (isLargeIdScope(scope)) {
    const { ids } = effectiveScopeFilter(scope);
    const idList = ids ?? [];
    const seenSig = new Set<string>();
    const pushUniq = (rows: Array<Record<string, unknown>>) => {
      for (const r of rows) {
        const k = String(r.id ?? "");
        if (!k || seenSig.has(k)) continue;
        seenSig.add(k);
        sigs.push(r);
      }
    };
    for (let off = 0; ; off += PAGE) {
      const { data: pageRows, error: pageErr } = await db
        .from("churn_signals")
        .select("id,customer_id,kind,objective,score,reason,status,evidence_json")
        .eq("store_id", storeId)
        .in("status", ["open", "prioritized"])
        .is("country", null)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(off, off + PAGE - 1);
      if (pageErr) throw new Error(`signals read: ${pageErr.message}`);
      const rows = (pageRows ?? []) as Array<Record<string, unknown>>;
      pushUniq(rows);
      if (rows.length < PAGE) break;
      if (sigs.length >= CAP) {
        sigTruncated = true;
        break;
      }
    }
    if (!sigTruncated) {
      for (const c of chunkIds(idList)) {
        let chunkDone = false;
        for (let off = 0; !chunkDone; off += PAGE) {
          const { data: pageRows, error: pageErr } = await db
            .from("churn_signals")
            .select("id,customer_id,kind,objective,score,reason,status,evidence_json")
            .eq("store_id", storeId)
            .in("status", ["open", "prioritized"])
            .in("customer_id", c)
            .order("created_at", { ascending: false })
            .order("id", { ascending: true })
            .range(off, off + PAGE - 1);
          if (pageErr) throw new Error(`signals read: ${pageErr.message}`);
          const rows = (pageRows ?? []) as Array<Record<string, unknown>>;
          pushUniq(rows);
          if (rows.length < PAGE) chunkDone = true;
          if (sigs.length >= CAP) {
            sigTruncated = true;
            chunkDone = true;
            break;
          }
        }
        if (sigTruncated) break;
      }
    }
  } else {
  for (let off = 0; ; off += PAGE) {
    const pageQ = applyScopeFilter(
      db
        .from("churn_signals")
        .select("id,customer_id,kind,objective,score,reason,status,evidence_json")
        .eq("store_id", storeId)
        .in("status", ["open", "prioritized"]),
      scope,
    );
    const { data: pageRows, error: pageErr } = await pageQ
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(off, off + PAGE - 1);
    if (pageErr) throw new Error(`signals read: ${pageErr.message}`);
    const rows = (pageRows ?? []) as Array<Record<string, unknown>>;
    sigs.push(...rows);
    if (rows.length < PAGE) break;
    if (sigs.length >= CAP) {
      sigTruncated = true;
      break;
    }
  }
  }
  if (sigs.length === 0) return { rows: [], foreign: [] };
  if (sigTruncated) {
    const { createLogger } = await import("@/lib/log");
    createLogger("mira")(`store ${storeId} señales truncadas a ${sigs.length} (CAP ${CAP}): ranking parcial`);
  }

  const ids = [...new Set(sigs.map((r) => String(r.customer_id ?? "")))].filter(Boolean);
  const sigIds = [...new Set(sigs.map((r) => String(r.id ?? "")))].filter(Boolean);
  // .in() con miles de IDs revienta URL PostgREST: chunk de 200.
  async function chunked<T>(keys: string[], fn: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < keys.length; i += 200) {
      out.push(...(await fn(keys.slice(i, i + 200))));
    }
    return out;
  }
  const [custRows, shopCurrency, actRows, predRows] = await Promise.all([
    chunked(ids, async (c) => {
      const { data, error } = await db
        .from("customers")
        .select("id,email,first_name,last_name,phone,company_name,orders_count,total_spent,currency,country")
        .eq("store_id", storeId)
        .in("id", c);
      if (error) throw new Error(`customers read: ${error.message}`);
      return (data ?? []) as Array<Record<string, unknown>>;
    }),
    resolveShopCurrency(storeId).catch(() => null),
    // Última acción por señal (la más reciente manda: rejected → redactable).
    // Sin .limit(): el chunk ya es 200 señales; el límite por chunk solo
    // truncaría a un heavy con >1000 acciones (inexistente en la práctica).
    chunked(sigIds, async (c) => {
      const all: Array<Record<string, unknown>> = [];
      for (let off = 0; ; off += 500) {
        const { data, error } = await db
          .from("proposed_actions")
          .select("signal_id,status,created_at")
          .eq("store_id", storeId)
          .in("signal_id", c)
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(off, off + 499);
        if (error) throw new Error(`actions read: ${error.message}`);
        const page = (data ?? []) as Array<Record<string, unknown>>;
        all.push(...page);
        if (page.length < 500) break;
      }
      return all;
    }),
    // Última predicción por cliente (el ranking principal). Sin .limit():
    // el chunk es 200 clientes; el historial por cliente no llega a 500.
    chunked(ids, async (c) => {
      const all: Array<Record<string, unknown>> = [];
      for (let off = 0; ; off += 500) {
        const { data } = await db
          .from("customer_predictions")
          .select("customer_id,model,valor_esperado_minor,p_recompra_h,decision,expected_days,as_of")
          .eq("store_id", storeId)
          .in("customer_id", c)
          .order("as_of", { ascending: false })
          .order("id", { ascending: true })
          .range(off, off + 499)
          .then(
            (res) => res,
            () => ({ data: null as null }),
          );
        const page = ((data ?? []) as Array<Record<string, unknown>> | null) ?? [];
        all.push(...page);
        if (page.length < 500) break;
      }
      return all;
    }),
  ]);
  const predByCust = new Map<
    string,
    { valor: number | null; p: number | null; decision: string | null; expectedDays: number | null; model: string | null }
  >();
  for (const r of ((predRows ?? []) as Array<Record<string, unknown>> | null) ?? []) {
    const cid = String(r.customer_id ?? "");
    if (!cid || predByCust.has(cid)) continue;
    predByCust.set(cid, {
      valor: r.valor_esperado_minor == null ? null : Number(r.valor_esperado_minor),
      p: r.p_recompra_h == null ? null : Number(r.p_recompra_h),
      decision: (r.decision as string | null) ?? null,
      expectedDays: r.expected_days == null ? null : Number(r.expected_days),
      model: (r.model as string | null) ?? null,
    });
  }
  const draftBySignal = new Map<string, MiraRow["draftStatus"]>();
  for (const a of ((actRows ?? []) as Array<Record<string, unknown>>)) {
    const sid = String(a.signal_id ?? "");
    if (!sid || draftBySignal.has(sid)) continue;
    const st = String(a.status ?? "");
    if (st === "pending_review") draftBySignal.set(sid, "pending");
    else if (st === "approved") draftBySignal.set(sid, "approved");
    else if (st === "dispatched") draftBySignal.set(sid, "dispatched");
  }
  const custById = new Map<string, Record<string, unknown>>();
  for (const c of ((custRows ?? []) as Array<Record<string, unknown>>))
    custById.set(String(c.id ?? ""), c);

  const allRows: MiraRow[] = sigs.map((r) => {
    const c = custById.get(String(r.customer_id ?? "")) ?? {};
    const raw = (r.reason as string | null) ?? null;
    const pred = predByCust.get(String(r.customer_id ?? "")) ?? null;
    return {
      signalId: String(r.id),
      customerDbId: String(r.customer_id ?? ""),
      kind: String(r.kind ?? "churn_risk"),
      objective: (r.objective as string | null) ?? null,
      score: r.score == null ? null : Number(r.score),
      reason: raw,
      daysSince: parseDaysSince(raw),
      status: String(r.status ?? ""),
      email: String(c.email ?? ""),
      firstName: (c.first_name as string | null) ?? null,
      lastName: (c.last_name as string | null) ?? null,
      phone: (c.phone as string | null) ?? null,
      companyName: (c.company_name as string | null) ?? null,
      ordersCount: Number(c.orders_count ?? 0),
      totalSpent: Number(c.total_spent ?? 0),
      currency: (c.currency as string | null) ?? null,
      country: (c.country as string | null) ?? null,
      draftStatus: draftBySignal.get(String(r.id)) ?? "none",
      pRecompraH: pred?.p ?? null,
      decision: pred?.decision ?? null,
      expectedDays: pred?.expectedDays ?? null,
      valorEsperadoMinor: pred?.valor ?? null,
      model: pred?.model ?? null,
      contactability: parseContactability((r.evidence_json as Record<string, unknown> | null) ?? null),
    };
  });
  // Ranking principal: valor_esperado_minor desc, desempate p_recompra_h desc.
  // Sin predicción (tienda sin corrida aún): al final, por antigüedad.
  const rankKey = (r: MiraRow): [number, number, number] => [
    r.valorEsperadoMinor ?? -1,
    r.pRecompraH ?? -1,
    r.daysSince ?? -1,
  ];
  const cmp = (a: MiraRow, b: MiraRow) => {
    const ka = rankKey(a);
    const kb = rankKey(b);
    // Sin predicción queda al final, ordenado por antigüedad.
    if ((a.valorEsperadoMinor == null) !== (b.valorEsperadoMinor == null)) {
      return a.valorEsperadoMinor == null ? 1 : -1;
    }
    for (let i = 0; i < 3; i += 1) {
      if (kb[i] !== ka[i]) return kb[i] - ka[i];
    }
    return 0;
  };
  // Universos separados: misma moneda rankea junta; la foránea no contamina
  // el ranking ni las sumas de la tienda (pero sigue su propio ranking).
  // Con filtro de mercado el market YA es el universo: todo va a rows.
  const scoped = !!scope && (scope.countries != null || scope.customerIds != null);
  const inShop = (r: MiraRow) =>
    scoped ||
    shopCurrency === null ||
    r.currency === null ||
    r.currency.toUpperCase() === shopCurrency.toUpperCase();
  const rows = allRows.filter(inShop);
  const foreign = allRows.filter((r) => !inShop(r));
  rows.sort(cmp);
  foreign.sort(cmp);
  // Limit al final (issue #11): el ranking por valor ya está completo.
  return { rows: rows.slice(0, limit), foreign: foreign.slice(0, limit) };
}
