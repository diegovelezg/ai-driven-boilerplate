// Parámetros aprendidos del motor por tenant (issue #27 Paso 3).
// Tres capas, frontera explícita:
//   Método (código: retention-model.ts): episodeize, mezcla EM, BIC, backtest.
//     Nadie lo escribe en runtime.
//   Parámetros (tabla tenant_model_params): episode_window_days y mezcla
//     K+(peso,μ,σ) por TENANT (single-país: una fila por tienda).
//     Solo los escribe el tune mensual con backtest obligatorio (Paso 4).
//     NUNCA se comparten entre tenants.
//   Arranque en frío: prior por arquetipo (código); sin fila válida aquí el
//     motor usa el comportamiento actual (sin episodios extra, grilla única).
// Este módulo: validación pura (testeable sin I/O) + resolución fail-open +
// escritor (solo lo llama el tune tras backtest ganador).
// El tune vive en model-tune.ts; aquí solo lectura/escritura validada.
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import {
  EPISODE_VERSION,
  EPISODE_WINDOW_MAX_DAYS,
  MIXTURE_MAX_K,
  MIXTURE_MU_MAX,
  MIXTURE_MU_MIN,
  MIXTURE_SIGMA_MAX,
  MIXTURE_SIGMA_MIN,
  MIXTURE_VERSION,
  asValidEpisodeWindowDays,
} from "@/lib/retention-model";

/** Versiones de método cuyos fits este lector sabe aplicar (issue #27 P2).
 *  Tras un cambio de método (p. ej. `mix2`), las filas viejas se rechazan
 *  (fail-open a legacy) en vez de aplicarse en silencio. */
const SUPPORTED_MODEL_PARAM_VERSIONS: ReadonlySet<string> = new Set([
  EPISODE_VERSION,
  MIXTURE_VERSION,
]);

export function isSupportedModelParamsVersion(v: unknown): v is string {
  return typeof v === "string" && SUPPORTED_MODEL_PARAM_VERSIONS.has(v);
}

export interface LearnedMixtureComponent {
  weight: number;
  mu: number;
  sigma: number;
}

export interface LearnedMixture {
  k: number;
  components: LearnedMixtureComponent[];
}

export interface TenantModelParams {
  /** Ventana de episodio en días; null = legacy (sin fusión temporal). */
  episodeWindowDays: number | null;
  /** Mezcla por partición; null = grilla única (legacy). */
  mixture: LearnedMixture | null;
}

export interface ModelParamsRow {
  params_json: unknown;
  /** Versión del método que ajustó la fila; ausente/desconocida ⇒ rechazo. */
  version?: string | null;
}

/** Valida un payload de `tenant_model_params` (puro).
 *  `version` debe ser un método soportado (P2: sin versión conocida no se
 *  aplica nada). Estricto en forma (k entero 1..4, pesos finitos >0 con suma
 *  ≈1) y en rango operativo (ventana ∈ (1,60], μ∈[ln1,ln1095],
 *  σ∈[0.25,1.4]: fuera de eso es basura persistida, no un ritmo).
 *  Retorna null si el payload no es utilizable (fail-open a legacy). */
export function validateModelParams(raw: unknown, version?: string | null): TenantModelParams | null {
  if (!isSupportedModelParamsVersion(version)) return null;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  let episodeWindowDays: number | null = null;
  const w = r.episode_window_days;
  if (typeof w === "number" && Number.isFinite(w)) {
    // >MAX es basura persistida (colapsaría F): se rechaza el payload entero
    // (fail-open a legacy), no se normaliza en silencio. <=1 es el default
    // legacy documentado (sin fusión temporal; ver asValidEpisodeWindowDays).
    if (w > EPISODE_WINDOW_MAX_DAYS) return null;
    episodeWindowDays = asValidEpisodeWindowDays(w);
  }
  let mixture: LearnedMixture | null = null;
  if (r.mixture !== undefined && r.mixture !== null) {
    if (typeof r.mixture !== "object" || r.mixture === null) return null;
    const m = r.mixture as Record<string, unknown>;
    const k = m.k;
    const comps = m.components;
    if (!Number.isInteger(k) || (k as number) < 1 || (k as number) > MIXTURE_MAX_K) return null;
    if (!Array.isArray(comps) || comps.length !== k) return null;
    const parsed: LearnedMixtureComponent[] = [];
    let sum = 0;
    for (const c of comps) {
      if (typeof c !== "object" || c === null) return null;
      const cc = c as Record<string, unknown>;
      const weight = cc.weight;
      const mu = cc.mu;
      const sigma = cc.sigma;
      if (
        typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0 ||
        typeof mu !== "number" || !Number.isFinite(mu) ||
        mu < MIXTURE_MU_MIN || mu > MIXTURE_MU_MAX ||
        typeof sigma !== "number" || !Number.isFinite(sigma) ||
        sigma < MIXTURE_SIGMA_MIN || sigma > MIXTURE_SIGMA_MAX
      ) {
        return null;
      }
      sum += weight;
      parsed.push({ weight, mu, sigma });
    }
    if (!(Math.abs(sum - 1) <= 1e-6)) return null;
    // Orden canónico por μ ascendente (ancla estable entre tunes).
    parsed.sort((a, b) => a.mu - b.mu);
    mixture = { k: k as number, components: parsed };
  }
  return { episodeWindowDays, mixture };
}

/** Elige la fila vigente del tenant (single-país: una sola fila).
 *  La validación incluye su `version`: fila inválida o de método desconocido
 *  ⇒ null (arranque en frío). */
export function pickModelParams(
  rows: ModelParamsRow[],
): TenantModelParams | null {
  const row = rows[0] ?? null;
  if (!row) return null;
  return validateModelParams(row.params_json, row.version ?? null);
}

/** Resuelve los parámetros aprendidos de una tienda (fail-open).
 *  Una sola fila (single-país); filtra por `version` soportada (P2: fits de
 *  un método viejo no se aplican en silencio). Sin fila válida ⇒ null y el
 *  motor usa prior de arquetipo (frío). Nunca lanza. */
export async function resolveModelParams(
  storeId: string,
): Promise<TenantModelParams | null> {
  try {
    if (!isSupabaseConfigured()) return null;
    const { data, error } = await getSupabase()
      .from("tenant_model_params")
      .select("params_json,version")
      .eq("store_id", storeId)
      .order("fitted_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const r = data as unknown as { params_json: unknown; version: unknown };
    return validateModelParams(
      r.params_json,
      typeof r.version === "string" ? r.version : null,
    );
  } catch {
    return null;
  }
}

/** Parámetros efectivos del tenant: fila vigente o frío. */
export function paramsForPartition(
  params: TenantModelParams | null,
): { params: TenantModelParams | null; source: "tienda" | "arquetipo" } {
  if (params) {
    return { params, source: "tienda" };
  }
  return { params: null, source: "arquetipo" };
}

export interface ModelParamsMeta {
  samples: number;
  events: number;
  backtest: Record<string, unknown>;
  fittedAt?: string;
}

/** Escritor de parámetros aprendidos (issue #27 Paso 4: solo lo llama el
 *  tune mensual tras backtest ganador). Valida con `validateModelParams` +
 *  versión ANTES del upsert (el escritor no guarda basura ni versiones
 *  futuras); single-país: una fila por tienda. Lanza en error (el tune lo
 *  captura en fail-open con motivo). */
export async function writeModelParams(
  storeId: string,
  params: TenantModelParams,
  version: string,
  meta: ModelParamsMeta,
): Promise<void> {
  const valid = validateModelParams(
    { episode_window_days: params.episodeWindowDays, mixture: params.mixture },
    version,
  );
  if (valid === null) throw new Error("Model params inválidos: se rechaza la escritura.");
  const db = getSupabase();
  const now = new Date().toISOString();
  const { error } = await db.from("tenant_model_params").upsert(
    {
      store_id: storeId,
      version,
      params_json: {
        episode_window_days: valid.episodeWindowDays,
        mixture: valid.mixture,
      },
      fitted_at: meta.fittedAt ?? now,
      samples: meta.samples,
      events: meta.events,
      backtest_json: meta.backtest ?? {},
      updated_at: now,
    },
    { onConflict: "store_id" },
  );
  if (error) throw new Error(`Model params write: ${error.message}`);
}
