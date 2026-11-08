// Muro de insights (issue #11): brecha KPI → lectura.
// Un solo proceso determinista (buildBriefFacts, sin LLM) + un solo narrador
// LLM (brief_narrate, con metering en ai_llm_usage). Sin swarm, sin auto-envíos,
// sin scoring probabilístico. Anti-ruido: máx 5/día, dedupe por (kind+scope),
// silencio si sin cambios.
import { getSupabase } from "@/lib/supabase";
import type { DashboardSnapshot } from "@/lib/dashboard";

export const BRIEF_KIND = "brief" as const;
export const BRIEF_NARRATE_PROCESS = "brief_narrate" as const;
export const MAX_POSTS_PER_DAY = 5;

export type InsightScopeKind = "order" | "company" | "screen" | "global";

export interface BriefFact {
  kind: string;
  scopeKind: InsightScopeKind;
  scopeId: string | null;
  title: string;
  detail: string;
  link: string;
}

export interface InsightPost extends BriefFact {
  body: string;
  severity: "info" | "warning" | "critical";
  audience: { user_ids: string[]; emails: string[]; roles: string[] };
}

const KIND_PRIORITY: Record<string, number> = {
  sin_om: 0,
  material: 1,
  sin_evidencia: 2,
  por_certificar: 3,
  termina_sin_relevo: 4,
  renovacion: 5,
  ocupacion: 6,
  huecos: 7,
};

const KIND_TITLE: Record<string, string> = {
  sin_om: "Falta OM: no se puede facturar",
  material: "Material sin aprobar",
  sin_evidencia: "Al aire sin evidencia",
  por_certificar: "Terminadas sin certificar",
  termina_sin_relevo: "Termina sin relevo",
  renovacion: "Relevo del anunciante",
  ocupacion: "Ocupación 14 días",
  huecos: "Huecos vendibles",
};

/** Analizador determinista: hechos con números exactos del snapshot.
//  Puro y testeable (tsx --test). Nunca inventa cifras: solo reformatea lo
//  que ya trae getDashboardSnapshot(). */
export function buildBriefFacts(snap: DashboardSnapshot, max = MAX_POSTS_PER_DAY): BriefFact[] {
  const facts: BriefFact[] = [];
  for (const a of snap.alerts ?? []) {
    facts.push({
      kind: a.kind,
      scopeKind: "order",
      scopeId: a.ioId,
      title: `${KIND_TITLE[a.kind] ?? a.kind} · ${a.ioNumber}`,
      detail: a.detail,
      link: `/orders?order=${a.ioId}`,
    });
  }
  if (snap.porCertificar > 0) {
    facts.push({
      kind: "por_certificar",
      scopeKind: "global",
      scopeId: null,
      title: `${KIND_TITLE.por_certificar} · ${snap.porCertificar}`,
      detail: `${snap.porCertificar} orden(es) terminada(s) sin foto-check — riesgo de disputa al cobrar.`,
      link: "/orders",
    });
  }
  const ren = snap.renovacion30d;
  if (ren.total > 0 && ren.conRelevo < ren.total) {
    const pct = ren.ratio === null ? "—" : `${Math.round(ren.ratio * 100)}%`;
    facts.push({
      kind: "renovacion",
      scopeKind: "global",
      scopeId: null,
      title: `Relevo 30d · ${ren.conRelevo}/${ren.total} (${pct})`,
      detail: `${ren.total - ren.conRelevo} orden(es) que vencen en 30d sin siguiente orden del mismo anunciante.`,
      link: "/orders",
    });
  }
  const oc = snap.ocupacion14d;
  if (oc.ratio !== null) {
    facts.push({
      kind: "ocupacion",
      scopeKind: "global",
      scopeId: null,
      title: `Ocupación 14d · ${Math.round(oc.ratio * 100)}%`,
      detail: `${oc.diasVendidos} de ${oc.diasDisponibles} pantalla-día vendidos en 14d.`,
      link: "/screens",
    });
  }
  if ((snap.huecos ?? []).length > 0) {
    const top = (snap.huecos ?? []).slice(0, 3);
    const libres = top.reduce((n, h) => n + h.diasLibres, 0);
    facts.push({
      kind: "huecos",
      scopeKind: "global",
      scopeId: null,
      title: `Huecos · ${libres}d libres (top ${top.length})`,
      detail: top.map((h) => `${h.screenName} ${h.diasLibres}d`).join(" · "),
      link: "/screens",
    });
  }
  facts.sort(
    (a, b) =>
      (KIND_PRIORITY[a.kind] ?? 99) - (KIND_PRIORITY[b.kind] ?? 99) ||
      a.title.localeCompare(b.title),
  );
  // Dedupe por (kind+scope) dentro del propio snapshot.
  const seen = new Set<string>();
  const out: BriefFact[] = [];
  for (const f of facts) {
    const k = dedupeKey(f.kind, f.scopeId);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
    if (out.length >= max) break;
  }
  return out;
}

export function dedupeKey(kind: string, scopeId: string | null): string {
  return `${kind}:${scopeId ?? "global"}`;
}

/** Arrobas desde auditoría (actor.ts: created_by/updated_by guardan email).
 *  Reglas del issue #11: creado==editado o uno null → un solo @;
 *  difieren → @ a ambos (creador responsable, editor contexto);
 *  updated_at >30d → pesa el creador. Puro y testeable. */
export function resolveMentions(
  createdBy: string | null | undefined,
  updatedBy: string | null | undefined,
  updatedAt: string | null | undefined,
  nowMs = Date.now(),
): string[] {
  const clean = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const e = v.trim().toLowerCase();
    return e.length >= 5 && e.includes("@") ? e : null;
  };
  const c = clean(createdBy);
  const u = clean(updatedBy);
  if (!c && !u) return [];
  if (!c) return [u!];
  if (!u || u === c) return [c];
  const t = typeof updatedAt === "string" && updatedAt ? Date.parse(updatedAt) : NaN;
  if (Number.isFinite(t) && nowMs - (t as number) > 30 * 86_400_000) return [c];
  return [c, u];
}

/** Mapea emails → membresías (user_ids) para audience_json. Puro. */
export function mapAudience(
  emails: string[],
  members: Array<{ user_id: string; email: string | null }>,
  roles: string[] = [],
): { user_ids: string[]; emails: string[]; roles: string[] } {
  const byEmail = new Map(
    members
      .filter((m) => typeof m.email === "string" && m.email)
      .map((m) => [(m.email as string).trim().toLowerCase(), m.user_id]),
  );
  const user_ids = [...new Set(emails.map((e) => byEmail.get(e.trim().toLowerCase())).filter((v): v is string => Boolean(v)))];
  return { user_ids, emails: [...new Set(emails.map((e) => e.trim().toLowerCase()))], roles: [...new Set(roles)] };
}

export interface WallInsight {
  id: string;
  kind: string;
  title: string;
  body: string;
  links: string[];
  audience: { user_ids: string[]; emails: string[]; roles: string[] };
  severity: string;
  scopeKind: InsightScopeKind | null;
  scopeId: string | null;
  createdAt: string;
  dismissed: boolean;
  mine: boolean;
}

/** ¿Este post es de `Mis pendientes` para (userId, email, role)? */
export function isMine(
  audience: { user_ids?: string[]; emails?: string[]; roles?: string[] },
  me: { userId: string | null; email: string | null; role: string | null },
): boolean {
  const aud = {
    user_ids: audience.user_ids ?? [],
    emails: (audience.emails ?? []).map((e) => e.toLowerCase()),
    roles: audience.roles ?? [],
  };
  if (me.userId && aud.user_ids.includes(me.userId)) return true;
  if (me.email && aud.emails.includes(me.email.trim().toLowerCase())) return true;
  if (me.role && aud.roles.includes(me.role)) return true;
  return false;
}

/** Lee el muro del tenant (últimos 20) con dismiss + `mine` resueltos. */
export async function listWallInsights(
  storeId: string,
  me: { userId: string | null; email: string | null; role: string | null },
): Promise<WallInsight[]> {
  const db = getSupabase();
  const { data: rows } = await db
    .from("sys_insights")
    .select("id,kind,title,body,links_json,audience_json,severity,scope_kind,scope_id,created_at")
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .limit(20);
  const list = ((rows ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    kind: String(r.kind ?? ""),
    title: String(r.title ?? ""),
    body: String(r.body ?? ""),
    links: Array.isArray(r.links_json) ? (r.links_json as unknown[]).map(String) : [],
    audience: ((): { user_ids: string[]; emails: string[]; roles: string[] } => {
      const a = r.audience_json as Record<string, unknown> | null;
      return {
        user_ids: Array.isArray(a?.user_ids) ? (a?.user_ids as unknown[]).map(String) : [],
        emails: Array.isArray(a?.emails) ? (a?.emails as unknown[]).map(String) : [],
        roles: Array.isArray(a?.roles) ? (a?.roles as unknown[]).map(String) : [],
      };
    })(),
    severity: String(r.severity ?? "info"),
    scopeKind: (r.scope_kind as InsightScopeKind | null) ?? null,
    scopeId: (r.scope_id as string | null) ?? null,
    createdAt: String(r.created_at ?? ""),
  }));
  let readIds = new Set<string>();
  if (me.userId && list.length > 0) {
    const { data: reads } = await db
      .from("sys_insight_reads")
      .select("insight_id")
      .in(
        "insight_id",
        list.map((i) => i.id),
      )
      .eq("user_id", me.userId);
    readIds = new Set(((reads ?? []) as Array<Record<string, unknown>>).map((r) => String(r.insight_id)));
  }
  return list.map((i) => ({
    ...i,
    dismissed: readIds.has(i.id),
    mine: isMine(i.audience, me),
  }));
}

function fallbackBody(f: BriefFact): string {
  return `${f.detail} Acción: abrir ${f.link}.`;
}

/** Narrador único (brief_narrate): hechos → 3-5 posts con explicación +
 *  1 accionable con deep-link. Prohibido inventar cifras: el prompt lo exige
 *  y el fallback ni siquiera toca un LLM. Con metering en ai_llm_usage. */
async function narrateFacts(storeId: string, facts: BriefFact[]): Promise<Array<Pick<InsightPost, "title" | "body" | "severity"> & { kind: string; scopeKind: InsightScopeKind; scopeId: string | null; link: string }>> {
  try {
    const { getLlmConfig } = await import("@/lib/ai/llm-config");
    const { completeJson } = await import("@/lib/retrieval");
    const cfg = getLlmConfig(BRIEF_NARRATE_PROCESS);
    const system = [
      "Narras el muro diario de una comercializadora DOOH peruana.",
      "Recibes HECHOS con números exactos. PROHIBIDO inventar cifras, montos,",
      "porcentajes o nombres: solo explicas el porqué y das 1 accionable con",
      "el deep-link dado. Sin novedad no hay post (aquí siempre hay hechos).",
      "Responde SOLO JSON: {\"posts\": [{\"kind\": string, \"body\": string, \"severity\": \"info\"|\"warning\"|\"critical\"}]}.",
      "body: 1-2 frases de explicación + 1 accionable. Sin cifras nuevas.",
    ].join(" ");
    const user = JSON.stringify({ facts: facts.map((f) => ({ kind: f.kind, scope: f.scopeId ?? "global", title: f.title, detail: f.detail, link: f.link })) });
    const order = [cfg.primary, cfg.fallback, cfg.fallback].filter(Boolean);
    let raw = "";
    for (let i = 0; i < order.length; i++) {
      try {
        raw = await completeJson(order[i]!, cfg.temperature, cfg.maxTokens, cfg.reasoningEffort, system, user, {
          storeId,
          process: BRIEF_NARRATE_PROCESS,
          usedFallback: i > 0,
        });
        break;
      } catch {
        if (i === order.length - 1) throw new Error("narrate-fail");
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    const parsed = JSON.parse(raw) as { posts?: Array<{ kind?: unknown; body?: unknown; severity?: unknown }> };
    const allowed = new Map(facts.map((f) => [dedupeKey(f.kind, f.scopeId), f]));
    const out: Array<{ kind: string; scopeKind: InsightScopeKind; scopeId: string | null; title: string; body: string; severity: "info" | "warning" | "critical"; link: string }> = [];
    for (const p of parsed.posts ?? []) {
      if (typeof p?.kind !== "string" || typeof p?.body !== "string") continue;
      const fact = facts.find((f) => f.kind === p.kind);
      if (!fact) continue; // kind fuera de hechos = invento: se descarta
      const key = dedupeKey(fact.kind, fact.scopeId);
      if (!allowed.has(key)) continue;
      allowed.delete(key);
      const body = p.body.trim().slice(0, 600);
      if (!body) continue;
      const sev = p.severity === "critical" || p.severity === "warning" ? p.severity : "info";
      out.push({ kind: fact.kind, scopeKind: fact.scopeKind, scopeId: fact.scopeId, title: fact.title, body, severity: sev, link: fact.link });
      if (out.length >= MAX_POSTS_PER_DAY) break;
    }
    if (out.length > 0) return out;
    throw new Error("narrate-empty");
  } catch {
    return facts.map((f) => ({ kind: f.kind, scopeKind: f.scopeKind, scopeId: f.scopeId, title: f.title, body: fallbackBody(f), severity: "info" as const, link: f.link }));
  }
}

/** Job determinista 1x día (sys_runs kind='brief'): snapshot → hechos →
 *  narrador → sys_insights. Silencio si sin cambios; tope 5/día. */
export async function runBriefJob(storeId: string): Promise<{ inserted: number; runId: string | null; summary: string }> {
  const { claimRunSlot, finishRun } = await import("@/lib/background");
  const { getDashboardSnapshot } = await import("@/lib/dashboard");
  const { startOfDayUTC } = await import("@/lib/dates");
  const db = getSupabase();
  let runId: string | null = null;
  try {
    runId = await claimRunSlot(storeId, BRIEF_KIND, "Muro diario", 1).catch(() => null);
  } catch {
    runId = null;
  }
  const done = async (summary: string, status: "done" | "error" = "done") => {
    if (runId) await finishRun(runId, { status, processed: 1, failed: 0, summary }).catch(() => undefined);
    return { inserted: 0, runId, summary };
  };
  try {
    const today00 = startOfDayUTC(Date.now());
    const { data: today } = await db
      .from("sys_insights")
      .select("id,kind,scope_id")
      .eq("store_id", storeId)
      .gte("created_at", new Date(today00).toISOString());
    const existing = new Set(((today ?? []) as Array<Record<string, unknown>>).map((r) => dedupeKey(String(r.kind ?? ""), (r.scope_id as string | null) ?? null)));
    if (existing.size >= MAX_POSTS_PER_DAY) return done(`Muro: techo ${MAX_POSTS_PER_DAY}/día alcanzado, silencio.`);
    const snap = await getDashboardSnapshot(storeId);
    const facts = buildBriefFacts(snap, MAX_POSTS_PER_DAY).filter((f) => !existing.has(dedupeKey(f.kind, f.scopeId)));
    if (facts.length === 0) return done("Muro: sin cambios, silencio.");
    // Arrobas desde auditoría de las OIs con scope (issue #11).
    const orderIds = [...new Set(facts.filter((f) => f.scopeKind === "order" && f.scopeId).map((f) => f.scopeId as string))];
    let audit = new Map<string, { created_by: string | null; updated_by: string | null; updated_at: string | null }>();
    if (orderIds.length > 0) {
      const { data } = await db.from("io_orders").select("id,created_by,updated_by,updated_at").in("id", orderIds).limit(100);
      audit = new Map(((data ?? []) as Array<Record<string, unknown>>).map((r) => [String(r.id), {
        created_by: (r.created_by as string | null) ?? null,
        updated_by: (r.updated_by as string | null) ?? null,
        updated_at: (r.updated_at as string | null) ?? null,
      }]));
    }
    let members: Array<{ user_id: string; email: string | null }> = [];
    try {
      const { listStoreMembers } = await import("@/lib/members");
      members = await listStoreMembers(storeId);
    } catch {
      members = [];
    }
    const narrated = await narrateFacts(storeId, facts);
    const rows = narrated.slice(0, MAX_POSTS_PER_DAY - existing.size).map((p) => {
      const a = p.scopeKind === "order" && p.scopeId ? audit.get(p.scopeId) : undefined;
      const emails = a ? resolveMentions(a.created_by, a.updated_by, a.updated_at) : [];
      const roles = p.scopeKind === "global" ? ["seller", "admin"] : [];
      return {
        store_id: storeId,
        kind: p.kind,
        title: p.title,
        body: p.body,
        links_json: [p.link],
        audience_json: mapAudience(emails, members, roles),
        severity: p.severity,
        scope_kind: p.scopeKind,
        scope_id: p.scopeId,
      };
    });
    if (rows.length === 0) return done("Muro: sin cambios, silencio.");
    const { error } = await db.from("sys_insights").insert(rows);
    if (error) throw new Error(`Insights insert: ${error.message}`);
    const summary = `Muro: ${rows.length} post(s) (hechos deterministas + ${BRIEF_NARRATE_PROCESS}).`;
    if (runId) await finishRun(runId, { status: "done", processed: 1, failed: 0, summary }).catch(() => undefined);
    return { inserted: rows.length, runId, summary };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Fallo el muro diario.";
    if (runId) {
      const { finishRun: fr, formatRunError } = await import("@/lib/background");
      await fr(runId, { status: "error", processed: 0, failed: 1, error: formatRunError(e) }).catch(() => undefined);
    }
    return { inserted: 0, runId, summary: msg };
  }
}
