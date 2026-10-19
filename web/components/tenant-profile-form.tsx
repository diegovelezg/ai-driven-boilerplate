"use client";

import { useActionState, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppCard } from "@/components/app-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
} from "@/lib/store-profiles";

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

export function TenantProfileForm({ storeId, profile, suggestion }: Props) {
  const [state, action, pending] = useActionState(saveTenantProfileAction, null);
  const [step, setStep] = useState<1 | 2>(profile ? 2 : 1);

  // Descripción acumulada del chat (se guarda con el perfil).
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
    setStep(2);
  };

  const useDataSignal = () => {
    setModel(suggestion.businessModel);
    setArchetype(suggestion.archetype);
    setCompanyRequired(ARCHETYPES[suggestion.archetype].companyRequired);
    setMult(String(ARCHETYPES[suggestion.archetype].defaultMultiplier));
    setSource("sugerido");
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

  const profileFooter = (
    <span className="flex flex-wrap items-center gap-3">
      <Button type="button" variant="outline" onClick={() => setStep(1)}>
        Atrás
      </Button>
      <Button type="submit" disabled={pending}>
        {pending ? "Guardando…" : "Guardar perfil"}
      </Button>
      {state && (
        <span className={state.ok ? "text-xs text-green-600" : "text-xs text-destructive"}>
          {state.message}
        </span>
      )}
    </span>
  );

  return (
    <div className="flex w-full max-w-2xl flex-col gap-4">
      {step === 1 ? (
        <AppCard
          title={`Perfil del negocio · paso ${formatNumber(step)} de 2`}
          description="Cuéntanos qué vendes y a quién, con tus palabras."
          action={
            <Badge variant={profile ? "default" : "secondary"}>
              {profile ? "Perfil configurado" : "Sin perfil"}
            </Badge>
          }
        >
          <ProfileChat
            storeId={storeId}
            onConfirm={handleChatConfirm}
            onUseDataSignal={useDataSignal}
          />
        </AppCard>
      ) : (
        <form action={action} className="flex flex-col">
          <AppCard
            title={`Perfil del negocio · paso ${formatNumber(step)} de 2`}
            description="Confirma lo que generó el set — ajusta lo que sea antes de guardar."
            action={
              <Badge variant={profile ? "default" : "secondary"}>
                {profile ? "Perfil configurado" : "Sin perfil"}
              </Badge>
            }
            footer={profileFooter}
          >
            <div className="flex flex-col gap-3">
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

              <div className="grid gap-1.5">
                <Label htmlFor="businessModel">¿A quién le vendes?</Label>
                <Select value={model} onValueChange={(v) => onModelChange(v as BusinessModel)}>
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

              <div className="grid gap-1.5">
                <Label htmlFor="taxonomy">¿A qué se dedica tu negocio?</Label>
                {verticalDetected && (
                  <p className="text-xs text-muted-foreground">
                    El agente detectó: {verticalDetected}.
                  </p>
                )}
                <Select value={taxonomyId ?? ""} onValueChange={onTaxonomyChange}>
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

              <div className="grid gap-1.5">
                <Label htmlFor="buyerType">¿Quién te compra?</Label>
                <Input
                  id="buyerType"
                  value={buyerType ?? ""}
                  maxLength={60}
                  onChange={(e) => {
                    setBuyerType(e.target.value || null);
                    setSource("manual");
                  }}
                  placeholder="Ej. negocio pequeño anunciante"
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="cycle">Recompra cada (días)</Label>
                  <Input
                    id="cycle"
                    inputMode="numeric"
                    value={cycle}
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
                <div className="grid gap-1.5">
                  <Label htmlFor="mult">Multiplicador de churn</Label>
                  <Input
                    id="mult"
                    inputMode="decimal"
                    value={mult}
                    onChange={(e) => setMult(e.target.value.replace(/[^0-9.]/g, "").slice(0, 4))}
                    placeholder="1.25"
                  />
                  <p className="text-xs text-muted-foreground">
                    Alerta cuando inactividad &gt; ciclo × esto (1.0–5.0).
                  </p>
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm" htmlFor="companyRequired">
                <input
                  id="companyRequired"
                  type="checkbox"
                  checked={companyRequired}
                  onChange={(e) => {
                    setCompanyRequired(e.target.checked);
                    setSource("manual");
                  }}
                  className="size-4 accent-primary"
                />
                Mis clientes son empresas (pedir RUC/empresa)
              </label>

              <p className="text-xs text-muted-foreground">
                Patrón que usará el motor: {ARCHETYPES[archetype].label}.
              </p>

              {reading && reading.understood.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Según tu descripción: {reading.understood.join(" · ")}.
                </p>
              )}
            </div>
          </AppCard>
        </form>
      )}
    </div>
  );
}
