"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppCard } from "@/components/app-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Steps } from "@/components/steps";
import { toast } from "@/components/ui/toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { saveTenantProfileAction } from "@/lib/profile-actions";
import type { DescriptionInterpretation } from "@/lib/profile-interpreter";
import { ProfileChat } from "@/components/profile-chat";
import { VERTICALS, verticalName } from "@/lib/taxonomy";
import { formatNumber } from "@/lib/format";
import {
  ARCHETYPES,
  type ArchetypeId,
  type BusinessModel,
  type CatalogType,
  type StoreProfile,
  type Suggestion,
} from "@/lib/store-profile-defs";

interface Props {
  storeId: string | null;
  profile: StoreProfile | null;
  suggestion: Suggestion;
}

const MODELS: Array<{ value: BusinessModel; label: string }> = [
  { value: "b2c", label: "B2C · vendo a personas" },
  { value: "b2b", label: "B2B · vendo a empresas" },
  { value: "hybrid", label: "Híbrido · a ambos" },
];

/** Arquetipo por defecto cuando el merchant cambia el modelo a mano. */
const MODEL_DEFAULT_ARCHETYPE: Record<BusinessModel, ArchetypeId> = {
  b2c: "b2c_consumible",
  b2b: "b2b_recurrente",
  hybrid: "hibrido",
};

/** Resumen del perfil guardado (reusado en resumen y como referencia en paso 1). */
function ProfileRecap({ profile }: { profile: StoreProfile }) {
  return (
    <dl className="mt-2 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
      <div className="flex gap-2">
        <dt className="shrink-0 text-muted-foreground">Modelo:</dt>
        <dd className="font-medium">
          {MODELS.find((m) => m.value === profile.businessModel)?.label ??
            profile.businessModel}
        </dd>
      </div>
      <div className="flex gap-2">
        <dt className="shrink-0 text-muted-foreground">Rubro:</dt>
        <dd className="font-medium">
          {verticalName(profile.taxonomyId) ??
            profile.industry ??
            profile.verticalDetected ??
            "—"}
        </dd>
      </div>
      <div className="flex gap-2">
        <dt className="shrink-0 text-muted-foreground">Compra:</dt>
        <dd className="font-medium">
          {[
            profile.buyerType,
            profile.companyRequired ? "empresas" : null,
          ]
            .filter(Boolean)
            .join(" · ") || "—"}
        </dd>
      </div>
      <div className="flex gap-2">
        <dt className="shrink-0 text-muted-foreground">Patrón:</dt>
        <dd className="font-medium">
          {ARCHETYPES[profile.archetype]?.label ?? profile.archetype}
        </dd>
      </div>
      <div className="flex gap-2">
        <dt className="shrink-0 text-muted-foreground">Recompra:</dt>
        <dd className="font-medium">
          {profile.repurchaseCycleDays != null
            ? `cada ~${formatNumber(profile.repurchaseCycleDays)}d`
            : `auto (~${formatNumber(ARCHETYPES[profile.archetype]?.defaultCycleDays ?? 0)}d)`}{" "}
          · churn ×{profile.churnMultiplier}
        </dd>
      </div>
    </dl>
  );
}

export function TenantProfileForm({ storeId, profile, suggestion }: Props) {
  // Guardado instantáneo (sin corrida): el resultado va al toast (SSOT).
  const [pending, startSave] = useTransition();
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(profile ? 2 : 1);
  // Paridad con Tienda/Email: con perfil guardado, el paso 2 viaja bloqueado
  // hasta "Cambiar". Sin perfil (primera vez) se edita directo.

  // Descripción del chat + elaboración de la IA (se guarda con el perfil).
  const [description, setDescription] = useState(profile?.description ?? "");
  const [reading, setReading] = useState<DescriptionInterpretation | null>(null);

  // Confirmación visible
  const [model, setModel] = useState<BusinessModel>(profile?.businessModel ?? suggestion.businessModel);
  const [industry, setIndustry] = useState<string | null>(profile?.industry ?? null);
  // Verdad del agente (primaria) + mapeo Shopify (derivado, nullable).
  const [verticalDetected, setVerticalDetected] = useState<string | null>(
    profile?.verticalDetected ?? null,
  );
  const [taxonomyId, setTaxonomyId] = useState<string | null>(profile?.taxonomyId ?? null);
  const [buyerType, setBuyerType] = useState<string | null>(profile?.buyerType ?? null);

  // Derivado por detrás (no se muestra; lo usa el motor de churn)
  const [archetype, setArchetype] = useState<ArchetypeId>(profile?.archetype ?? suggestion.archetype);
  const [catalog, setCatalog] = useState<CatalogType | null>(profile?.catalogType ?? null);
  const [cycle, setCycle] = useState(profile?.repurchaseCycleDays?.toString() ?? "");
  const [mult, setMult] = useState(
    profile ? String(profile.churnMultiplier) : String(ARCHETYPES[suggestion.archetype].defaultMultiplier),
  );
  const [companyRequired, setCompanyRequired] = useState<boolean>(
    profile?.companyRequired ?? ARCHETYPES[suggestion.archetype].companyRequired,
  );
  const [source, setSource] = useState<"manual" | "sugerido">(
    profile?.archetypeSource === "sugerido" ? "sugerido" : "manual",
  );
  const [confidence, setConfidence] = useState<"alta" | "media" | "baja" | null>(
    profile?.interpretationConfidence ?? null,
  );
  const [criticInfo, setCriticInfo] = useState<{
    verdict: "accept" | "reject";
    reasons: string[];
  } | null>(null);
  const [editing, setEditing] = useState(false);
  const locked = profile != null && !editing;
  // El generador (investigación del chat / perfil profundo) bloquea la
  // salida a edición de valores hasta terminar.
  const [chatBusy, setChatBusy] = useState(false);

  /** Cancelar edición: revierte todo al perfil guardado (los campos son
   *  estado controlado, no basta con re-bloquear). */
  const resetFromSaved = () => {
    if (!profile) return;
    setModel(profile.businessModel);
    setIndustry(profile.industry ?? null);
    setVerticalDetected(profile.verticalDetected ?? null);
    setTaxonomyId(profile.taxonomyId ?? null);
    setBuyerType(profile.buyerType ?? null);
    setArchetype(profile.archetype);
    setCatalog(profile.catalogType ?? null);
    setCycle(profile.repurchaseCycleDays?.toString() ?? "");
    setMult(String(profile.churnMultiplier));
    setCompanyRequired(profile.companyRequired);
    setSource(profile.archetypeSource === "sugerido" ? "sugerido" : "manual");
    setConfidence(profile.interpretationConfidence ?? null);
    setDescription(profile.description ?? "");
    setReading(null);
    setCriticInfo(null);
    setEditing(false);
  };

  if (!storeId) {
    return (
      <AppCard
        title="Perfil del negocio"
        description="Conecta Medusa arriba (Guardar y conectar) para crear el store y describir tu negocio."
      >
        <span className="text-xs text-muted-foreground">Sin store todavía.</span>
      </AppCard>
    );
  }

  const applyInterpretation = (
    r: DescriptionInterpretation & { taxonomyId?: string | null },
    fullDescription?: string,
  ) => {
    setReading(r);
    if (fullDescription !== undefined) setDescription(fullDescription);
    const m = r.businessModel ?? model;
    const a = (r.archetype && r.businessModel ? r.archetype : MODEL_DEFAULT_ARCHETYPE[m]);
    setModel(m);
    setArchetype(a);
    setCompanyRequired(r.companyRequired || ARCHETYPES[a].companyRequired);
    setMult(String(ARCHETYPES[a].defaultMultiplier));
    if (r.vertical) setVerticalDetected(r.vertical);
    if (r.buyerType) setBuyerType(r.buyerType);
    if (r.taxonomyId) {
      setTaxonomyId(r.taxonomyId);
      setIndustry(verticalName(r.taxonomyId));
    } else if (r.industry) {
      setIndustry(r.industry);
    }
    if (r.catalogType) setCatalog(r.catalogType);
    if (r.cycleDays) setCycle(String(r.cycleDays));
    setConfidence(r.confidence);
    setSource("sugerido");
  };

  // El chat propone, el set enriquece, el humano confirma: recién ahí se aplica y se avanza.
  const handleChatConfirm = (
    proposal: DescriptionInterpretation & { taxonomyId?: string | null },
    fullDescription: string,
    info?: { criticVerdict: "accept" | "reject"; criticReasons: string[] },
  ) => {
    applyInterpretation(proposal, fullDescription);
    setCriticInfo(info ? { verdict: info.criticVerdict, reasons: info.criticReasons } : null);
    // Lo recién generado llega en edición: con perfil existente, sin esto
    // el paso 2 aterriza bloqueado y el Guardar queda escondido tras Cambiar.
    setEditing(true);
    setStep(2);
  };

  const onTaxonomyChange = (v: string | null) => {
    setTaxonomyId(v || null);
    setIndustry(verticalName(v || null));
    setSource("manual");
  };

  const onModelChange = (v: BusinessModel) => {
    setModel(v);
    setSource("manual");
    // Re-derivar por detrás si el arquetipo ya no encaja con el modelo.
    if (ARCHETYPES[archetype].businessModel !== v && v !== "hybrid") {
      const a = MODEL_DEFAULT_ARCHETYPE[v];
      setArchetype(a);
      setCompanyRequired(ARCHETYPES[a].companyRequired);
      setMult(String(ARCHETYPES[a].defaultMultiplier));
    } else if (v === "hybrid" && archetype !== "hibrido") {
      setArchetype("hibrido");
      setCompanyRequired(false);
      setMult(String(ARCHETYPES.hibrido.defaultMultiplier));
    }
  };

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startSave(async () => {
      try {
        const r = await saveTenantProfileAction(null, fd);
        if (r.ok) {
          toast.add({ title: "Perfil guardado", description: r.message, type: "success" });
          queueMicrotask(() => setEditing(false));
          router.refresh();
        } else {
          toast.add({ title: "No se pudo guardar", description: r.message, type: "error" });
        }
      } catch (err) {
        // El action no debería lanzar (devuelve estado), pero si lo hace
        // no queda en silencio: toast de error.
        const message = err instanceof Error ? err.message : "Error al guardar";
        toast.add({ title: "No se pudo guardar", description: message, type: "error" });
      }
    });
  };

  const profileFooter = (
    <span className="flex flex-wrap items-center gap-3">
      <Button type="button" variant="outline" onClick={() => setStep(1)}>
        Atrás
      </Button>
      {locked ? (
        <Button type="button" variant="outline" onClick={() => setEditing(true)}>
          Cambiar
        </Button>
      ) : (
        <>
          <Button type="submit" disabled={pending}>
            {pending ? "Guardando…" : "Guardar perfil"}
          </Button>
          {profile && (
            <Button type="button" variant="ghost" onClick={resetFromSaved}>
              Cancelar
            </Button>
          )}
        </>
      )}
    </span>
  );

  // Resumen cuando ya está guardado (estándar: completo → estado, no paso 2).
  if (locked && profile) {
    return (
      <div className="flex w-full flex-col gap-4">
        <Steps steps={["Descríbelo", "Confirma"]} current={2} />
        <AppCard
          tone="violet"
          title="Perfil del negocio"
          description="Tu perfil está guardado."
          action={<Badge variant="success">Perfil configurado</Badge>}
          footer={
            <span className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                disabled={chatBusy}
                onClick={() => {
                  setEditing(true);
                  setStep(2);
                }}
              >
                Editar
              </Button>
            </span>
          }
        >
          <ProfileRecap profile={profile} />
          <div className="mt-4">
            <ProfileChat
              storeId={storeId}
              onConfirm={handleChatConfirm}
              onBusyChange={setChatBusy}
            />
          </div>
        </AppCard>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <Steps steps={["Descríbelo", "Confirma"]} current={step - 1} />
      {step === 1 ? (
        <AppCard
          tone="violet"
          title={`Perfil del negocio · paso ${formatNumber(step)} de 2`}
          description="Cuéntanos qué vendes y a quién, con tus palabras."
          action={
            <Badge variant={profile ? "success" : "secondary"}>
              {profile ? "Perfil configurado" : "Sin perfil"}
            </Badge>
          }
          footer={
            profile ? (
              <span className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  disabled={chatBusy}
                  onClick={() => {
                    setEditing(true);
                    setStep(2);
                  }}
                >
                  Editar valores
                </Button>
                <span className="text-xs text-muted-foreground">
                  O descríbeme el cambio abajo y lo aplicamos.
                </span>
              </span>
            ) : undefined
          }
        >
          {profile && (
            <div className="mb-4 rounded-lg border border-input p-3">
              <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                Tu perfil actual
              </p>
              <ProfileRecap profile={profile} />
            </div>
          )}
          {/* Sin vía sin-chat por diseño: el perfil nace conversando (con o sin
              web). Ante fallo del chat, sus errores reintentan; no hay callejón. */}
          <ProfileChat
            storeId={storeId}
            onConfirm={handleChatConfirm}
            onBusyChange={setChatBusy}
          />
        </AppCard>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col">
          <AppCard
            tone="violet"
            title={`Perfil del negocio · paso ${formatNumber(step)} de 2`}
            description="Confirma lo que generó el set — ajusta lo que sea antes de guardar."
            action={
              <Badge variant={profile ? "success" : "secondary"}>
                {profile ? "Perfil configurado" : "Sin perfil"}
              </Badge>
            }
            footer={profileFooter}
          >
            <div className="flex flex-col gap-6">
              {/* Todo lo derivado viaja oculto (el submit ocurre en el paso 2
                  pero la evidencia se acumula en el paso 1). */}
              <input type="hidden" name="description" value={description} />
              <input type="hidden" name="businessModel" value={model} />
              <input type="hidden" name="verticalDetected" value={verticalDetected ?? ""} />
              <input type="hidden" name="taxonomyId" value={taxonomyId ?? ""} />
              <input type="hidden" name="buyerType" value={buyerType ?? ""} />
              <input type="hidden" name="industry" value={industry ?? ""} />
              <input type="hidden" name="catalogType" value={catalog ?? ""} />
              <input type="hidden" name="archetype" value={archetype} />
              <input type="hidden" name="repurchaseCycleDays" value={cycle} />
              <input type="hidden" name="churnMultiplier" value={mult} />
              <input type="hidden" name="archetypeSource" value={source} />
              <input type="hidden" name="interpretationConfidence" value={confidence ?? ""} />
              {companyRequired && <input type="hidden" name="companyRequired" value="on" />}
              {profile?.notes && <input type="hidden" name="notes" value={profile.notes} />}

              {criticInfo && criticInfo.verdict === "reject" && criticInfo.reasons.length > 0 && (
                <div className="rounded-lg border border-input p-3 text-xs">
                  <p className="font-medium">El revisor corrigió la propuesta:</p>
                  <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                    {criticInfo.reasons.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex flex-col gap-4">
                <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  A quién vendes
                </p>
                <div className="grid gap-2">
                  <Label htmlFor="businessModel">¿A quién le vendes?</Label>
                  <Select value={model} onValueChange={(v) => onModelChange(v as BusinessModel)} disabled={locked}>
                    <SelectTrigger id="businessModel">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MODELS.map((m) => (
                        <SelectItem key={m.value} value={m.value}>
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="buyerType">¿Quién te compra?</Label>
                  <Input
                    id="buyerType"
                    value={buyerType ?? ""}
                    maxLength={60}
                    disabled={locked}
                    onChange={(e) => {
                      setBuyerType(e.target.value || null);
                      setSource("manual");
                    }}
                    placeholder="Ej. negocio pequeño anunciante"
                  />
                </div>

                <label
                  className="flex items-center gap-2.5 rounded-lg border border-input px-3 py-2.5 text-sm"
                  htmlFor="companyRequired"
                >
                  <input
                    id="companyRequired"
                    type="checkbox"
                    checked={companyRequired}
                    disabled={locked}
                    onChange={(e) => {
                      setCompanyRequired(e.target.checked);
                      setSource("manual");
                    }}
                    className="size-4 accent-primary"
                  />
                  Mis clientes son empresas (pedir RUC/empresa)
                </label>
              </div>

              <hr className="border-border/60" />
              <div className="flex flex-col gap-4">
                <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  Qué vendes
                </p>
                <div className="grid gap-2">
                  <Label htmlFor="taxonomy">¿A qué se dedica tu negocio?</Label>
                  {verticalDetected && (
                    <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                      El agente detectó: {verticalDetected}.
                    </p>
                  )}
                  <Select value={taxonomyId ?? ""} onValueChange={onTaxonomyChange} disabled={locked}>
                    <SelectTrigger id="taxonomy">
                      <SelectValue placeholder="Elegir…" />
                    </SelectTrigger>
                    <SelectContent>
                      {VERTICALS.map((v) => (
                        <SelectItem key={v.taxonomy_id} value={v.taxonomy_id}>
                          {v.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Elegido: {verticalName(taxonomyId) ?? "sin mapear (vale tu texto libre)"}.
                  </p>
                </div>
              </div>

              <hr className="border-border/60" />
              <div className="flex flex-col gap-4">
                <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  Cada cuánto vuelven
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid content-start gap-2">
                    <Label htmlFor="cycle">Recompra cada (días)</Label>
                    <Input
                      id="cycle"
                      inputMode="numeric"
                      value={cycle}
                      disabled={locked}
                      onChange={(e) => {
                        setCycle(e.target.value.replace(/[^0-9]/g, "").slice(0, 4));
                        setSource("manual");
                      }}
                      placeholder={`Auto (${ARCHETYPES[archetype].defaultCycleDays}d)`}
                    />
                    <p className="text-xs text-muted-foreground">
                      Propuesto por el set; vacío = auto del arquetipo.
                    </p>
                  </div>
                  <div className="grid content-start gap-2">
                    <Label htmlFor="mult">Multiplicador de churn</Label>
                    <Input
                      id="mult"
                      inputMode="decimal"
                      value={mult}
                      disabled={locked}
                      onChange={(e) => {
                        setMult(e.target.value.replace(/[^0-9.]/g, "").slice(0, 4));
                        setSource("manual");
                      }}
                      placeholder="1.25"
                    />
                    <p className="text-xs text-muted-foreground">
                      Alerta cuando inactividad &gt; ciclo × esto (1.0–5.0).
                    </p>
                  </div>
                </div>
              </div>

              <hr className="border-border/60" />
              <div className="flex flex-col gap-1.5">
                <p className="text-xs text-muted-foreground">
                  Patrón que usará el motor: {ARCHETYPES[archetype].label}.
                </p>

                {reading && reading.understood.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Según tu descripción: {reading.understood.join(" · ")}.
                  </p>
                )}
              </div>
            </div>
          </AppCard>
        </form>
      )}
    </div>
  );
}
