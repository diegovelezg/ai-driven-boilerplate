"use client";

import { useActionState, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { saveTenantProfileAction } from "@/lib/profile-actions";
import {
  interpretBusinessDescription,
  type DescriptionInterpretation,
} from "@/lib/profile-interpreter";
import {
  ARCHETYPES,
  INDUSTRIES,
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

const TEXTAREA_CLASS =
  "min-h-28 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function TenantProfileForm({ storeId, profile, suggestion }: Props) {
  const [state, action, pending] = useActionState(saveTenantProfileAction, null);
  const [step, setStep] = useState<1 | 2>(profile ? 2 : 1);

  // Entrada orgánica
  const [description, setDescription] = useState(profile?.description ?? "");
  const [reading, setReading] = useState<DescriptionInterpretation | null>(null);

  // Confirmación visible
  const [model, setModel] = useState<BusinessModel>(profile?.businessModel ?? suggestion.businessModel);
  const [industry, setIndustry] = useState<string | null>(profile?.industry ?? null);

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

  if (!storeId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Perfil del negocio</CardTitle>
          <CardDescription>
            Conecta Medusa arriba (Guardar y conectar) para crear el store y describir tu negocio.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const applyInterpretation = (r: DescriptionInterpretation) => {
    setReading(r);
    const m = r.businessModel ?? model;
    const a = (r.archetype && r.businessModel ? r.archetype : MODEL_DEFAULT_ARCHETYPE[m]);
    setModel(m);
    setArchetype(a);
    setCompanyRequired(ARCHETYPES[a].companyRequired);
    setMult(String(ARCHETYPES[a].defaultMultiplier));
    if (r.industry) setIndustry(r.industry);
    if (r.catalogType) setCatalog(r.catalogType);
    if (r.cycleDays) setCycle(String(r.cycleDays));
    setConfidence(r.confidence);
    setSource("sugerido");
  };

  const interpret = () => applyInterpretation(interpretBusinessDescription(description));

  const useDataSignal = () => {
    setModel(suggestion.businessModel);
    setArchetype(suggestion.archetype);
    setCompanyRequired(ARCHETYPES[suggestion.archetype].companyRequired);
    setMult(String(ARCHETYPES[suggestion.archetype].defaultMultiplier));
    setSource("sugerido");
    setStep(2);
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

  const canContinue = description.trim().length >= 10;

  return (
    <form action={action} className="flex w-full max-w-2xl flex-col gap-4">
      {/* Todo lo derivado viaja oculto: el arquetipo se trabaja por detrás. */}
      <input type="hidden" name="businessModel" value={model} />
      <input type="hidden" name="industry" value={industry ?? ""} />
      <input type="hidden" name="catalogType" value={catalog ?? ""} />
      <input type="hidden" name="archetype" value={archetype} />
      <input type="hidden" name="repurchaseCycleDays" value={cycle} />
      <input type="hidden" name="churnMultiplier" value={mult} />
      <input type="hidden" name="archetypeSource" value={source} />
      <input type="hidden" name="interpretationConfidence" value={confidence ?? ""} />
      {companyRequired && <input type="hidden" name="companyRequired" value="on" />}
      {profile?.notes && <input type="hidden" name="notes" value={profile.notes} />}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-sm font-medium">
              Perfil del negocio · paso {step} de 2
            </CardTitle>
            <Badge variant={profile ? "default" : "secondary"}>
              {profile ? "Perfil configurado" : "Sin perfil"}
            </Badge>
          </div>
          <CardDescription>
            {step === 1
              ? "Cuéntanos qué vendes y a quién, con tus palabras."
              : "Confirma estos dos datos — del resto nos encargamos nosotros."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {step === 1 ? (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="description">Describe tu negocio</Label>
                <textarea
                  id="description"
                  name="description"
                  className={TEXTAREA_CLASS}
                  rows={4}
                  placeholder="Ej. Tostaduría en Lima: vendemos café en grano a oficinas por suscripción mensual, y también a personas en tienda online…"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>

              {reading && (
                <div className="rounded-lg border border-input p-3 text-xs">
                  <p className="font-medium">
                    Lo que entendí{confidence ? ` (confianza ${confidence})` : ""}:
                  </p>
                  {reading.understood.length > 0 ? (
                    <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                      {reading.understood.map((u) => (
                        <li key={u}>{u}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-muted-foreground">
                      No pude extraer mucho — prueba con qué vendes, a quién y cada cuánto recompran.
                    </p>
                  )}
                  {reading.questions.length > 0 && (
                    <>
                      <p className="mt-2 font-medium">Para afinar:</p>
                      <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                        {reading.questions.map((q) => (
                          <li key={q}>{q}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" variant="outline" onClick={interpret} disabled={!canContinue}>
                  Interpretar
                </Button>
                <Button type="button" onClick={() => { if (!reading) interpret(); setStep(2); }} disabled={!canContinue}>
                  Continuar
                </Button>
                <button
                  type="button"
                  onClick={useDataSignal}
                  className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  Omitir y usar datos de la tienda
                </button>
              </div>
              {!canContinue && (
                <p className="text-xs text-muted-foreground">
                  Escribe al menos una frase (10 caracteres) para continuar.
                </p>
              )}
            </>
          ) : (
            <>
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
                <Label htmlFor="industry">¿A qué se dedica tu negocio?</Label>
                <Select value={industry ?? ""} onValueChange={(v) => { setIndustry(v || null); setSource("manual"); }}>
                  <SelectTrigger id="industry">
                    <SelectValue placeholder="Elegir…" />
                  </SelectTrigger>
                  <SelectContent>
                    {INDUSTRIES.map((i) => (
                      <SelectItem key={i} value={i}>
                        {i}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {reading && reading.understood.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Según tu descripción: {reading.understood.join(" · ")}.
                </p>
              )}

              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" variant="outline" onClick={() => setStep(1)}>
                  Atrás
                </Button>
                <Button type="submit" disabled={pending}>
                  {pending ? "Guardando…" : "Guardar perfil"}
                </Button>
                {state && (
                  <p className={state.ok ? "text-xs text-green-600" : "text-xs text-destructive"}>
                    {state.message}
                  </p>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </form>
  );
}
