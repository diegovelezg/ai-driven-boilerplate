"use client";

import { useCallback, useEffect, useState } from "react";
import { Globe, RotateCcw, Search } from "lucide-react";
import { AppCard, AppCardState } from "@/components/app-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface Candidate {
  domain: string;
  source: "company" | "company_email" | "contact" | "web";
  count: number;
}

interface Profile {
  domain: string;
  domain_type: string | null;
  company_name: string | null;
  industry: string | null;
  description: string | null;
  size: string | null;
  location: string | null;
  source_url: string | null;
  model: string | null;
  confidence: number | null;
  enriched_at: string | null;
}

const SOURCE_LABEL: Record<Candidate["source"], string> = {
  company: "Dominio empresa",
  company_email: "Email empresa",
  contact: "Emails contactos",
  web: "Descubierto web",
};

function SourceBadge({ c }: { c: Candidate }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge variant="secondary" className="font-normal" title={`Fuente del dominio: ${SOURCE_LABEL[c.source]}`}>
        {SOURCE_LABEL[c.source]}
      </Badge>
      {c.source === "contact" && c.count > 1 && (
        <span className="text-[11px] tabular-nums text-muted-foreground">×{c.count} contactos</span>
      )}
    </span>
  );
}

/** Tab Perfil de empresa: research por URL (dominio + emails de contactos). */
export function EmpresaResearch({ companyId, canResearch }: { companyId: string; canResearch: boolean }) {
  return <DomainResearchPanel researchBase={`/api/companies/${companyId}/research`} canResearch={canResearch} />;
}

/** Panel genérico de research por dominio(s) (ficha firmográfica en `domains`). */
export function DomainResearchPanel({ researchBase, canResearch }: { researchBase: string; canResearch: boolean }) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [discovered, setDiscovered] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [researching, setResearching] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(researchBase, { cache: "no-store" });
        const j = (await res.json()) as { candidates?: Candidate[]; profiles?: Profile[]; discoveredFromWeb?: string | null; error?: string };
        if (!res.ok) throw new Error(j.error ?? "No se pudo cargar el perfil.");
        if (!alive) return;
        setCandidates(j.candidates ?? []);
        setProfiles(j.profiles ?? []);
        setDiscovered(j.discoveredFromWeb ?? null);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "No se pudo cargar.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [researchBase]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(researchBase, { cache: "no-store" });
      const j = (await res.json()) as { candidates?: Candidate[]; profiles?: Profile[]; discoveredFromWeb?: string | null; error?: string };
      if (!res.ok) throw new Error(j.error ?? "No se pudo cargar el perfil.");
      setCandidates(j.candidates ?? []);
      setProfiles(j.profiles ?? []);
      setDiscovered(j.discoveredFromWeb ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar.");
    } finally {
      setLoading(false);
    }
  }, [researchBase]);

  const profileOf = (domain: string) => profiles.find((p) => p.domain === domain) ?? null;

  async function investigate(domain: string | null, force = false) {
    setMsg(null);
    setError(null);
    setResearching(domain ?? "__all__");
    try {
      const res = await fetch(researchBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(domain ? { domains: [domain], force } : { force }),
      });
      const j = (await res.json()) as {
        results?: Array<{ domain: string; status: string; profile?: Profile | null; error?: string; fallbackFor?: string }>;
        profiles?: Profile[];
        candidates?: Candidate[];
        error?: string;
      };
      if (!res.ok) throw new Error(j.error ?? "No se pudo investigar.");
      if (j.candidates) setCandidates(j.candidates);
      const mine = domain ? (j.results ?? []).find((r) => r.domain === domain) ?? null : null;
      const fallbackOk = domain
        ? (j.results ?? []).find((r) => r.fallbackFor === domain && (r.status === "ok" || r.status === "cached")) ?? null
        : null;
      if (mine && mine.status !== "ok" && mine.status !== "cached" && !fallbackOk) {
        setError(
          mine.status === "no-homepage"
            ? `No se pudo leer la web de ${domain} (no responde o bloquea bots) ni hallar otra por búsqueda. Verifica que el dominio siga vigente.`
            : (mine.error ?? "No se pudo investigar."),
        );
        return;
      }
      const incoming = new Map<string, Profile>();
      for (const r of j.results ?? []) if (r.profile) incoming.set(r.profile.domain, r.profile);
      for (const p of j.profiles ?? []) incoming.set(p.domain, p);
      if (incoming.size > 0) {
        setProfiles((prev) => {
          const next = new Map(prev.map((p) => [p.domain, p]));
          for (const p of incoming.values()) next.set(p.domain, p);
          return [...next.values()];
        });
      }
      setMsg(
        fallbackOk
          ? `${domain} no responde; se investigó ${fallbackOk.domain} (hallado por búsqueda web).`
          : force ? "Perfil actualizado." : "Investigación lista.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo investigar.");
    } finally {
      setResearching(null);
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Cargando perfil">
        <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
        <div className="h-24 animate-pulse rounded-lg bg-muted/60" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <div className="flex flex-col gap-3">
          <AppCardState>{error}</AppCardState>
          <Button variant="outline" size="sm" className="w-fit" onClick={() => void reload()}>
            Reintentar
          </Button>
        </div>
      )}
      {!error && (candidates ?? []).length === 0 && (
        <AppCard
          title="Perfil"
          description="Información pública de la empresa para completar su ficha."
          aria-label="Perfil de la empresa"
        >
          <p className="text-[13px] text-muted-foreground">
            Sin dominios para investigar: carga el dominio de la empresa o emails corporativos en sus
            contactos (se ignoran gmail/hotmail/outlook y similares).
          </p>
        </AppCard>
      )}
      {!error &&
        (candidates ?? []).map((c) => {
          const p = profileOf(c.domain);
          const busy = researching === c.domain || researching === "__all__";
          return (
            <AppCard
              key={c.domain}
              title={p?.company_name ?? c.domain}
              description={c.domain}
              aria-label={`Perfil ${c.domain}`}
              action={
                canResearch ? (
                  <span className="flex items-center gap-2">
                    {p && (
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void investigate(c.domain, true)} title="Re-investigar (re-scrapea la web)">
                        <RotateCcw aria-hidden /> Re-investigar
                      </Button>
                    )}
                    {!p && (
                      <Button size="sm" disabled={busy} onClick={() => void investigate(c.domain)}>
                        <Search aria-hidden /> {busy ? "Investigando…" : "Investigar"}
                      </Button>
                    )}
                  </span>
                ) : undefined
              }
            >
              <div className="mb-2">
                <SourceBadge c={c} />
              </div>
              {!p ? (
                <p className="text-[13px] text-muted-foreground">
                  Sin ficha aún. {canResearch ? "Investiga su web para extraer rubro, tamaño y descripción." : "Un seller puede investigarla."}
                </p>
              ) : (
                <dl className="grid gap-x-6 gap-y-2.5 text-sm sm:grid-cols-2">
                  <div><dt className="text-xs text-muted-foreground">Rubro</dt><dd className="mt-0.5 text-[13px]">{p.industry ?? "—"}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">Tamaño</dt><dd className="mt-0.5 text-[13px]">{p.size ?? "—"}</dd></div>
                  <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">Descripción</dt><dd className="mt-0.5 text-[13px]">{p.description ?? "—"}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">Ubicación</dt><dd className="mt-0.5 text-[13px]">{p.location ?? "—"}</dd></div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Confianza</dt>
                    <dd className="mt-0.5 text-[13px] tabular-nums">{p.confidence == null ? "—" : `${Math.round(p.confidence * 100)}%`}{p.model ? ` · ${p.model}` : ""}</dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="text-xs text-muted-foreground">Fuente</dt>
                    <dd className="mt-0.5 text-[13px]">
                      {p.source_url ? (
                        <a href={p.source_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-4">
                          <Globe className="size-3.5" aria-hidden /> {p.source_url}
                        </a>
                      ) : "—"}
                      {p.enriched_at && <span className="ml-2 text-xs text-muted-foreground">· {new Date(p.enriched_at).toLocaleDateString("es-PE")}</span>}
                    </dd>
                  </div>
                </dl>
              )}
            </AppCard>
          );
        })}
      {discovered && (
        <p className="text-xs text-muted-foreground">Dominio descubierto por búsqueda web: {discovered}.</p>
      )}
      {msg && <p className="text-xs text-muted-foreground" role="status">{msg}</p>}
    </div>
  );
}
