"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { AppCard, AppCardState } from "@/components/app-card";
import { toast } from "@/components/ui/toast";
import { saveMetadataMapAction, scanMetadataAction } from "@/lib/metadata-actions";
import type { MetadataKeyInfo } from "@/lib/metadata-map";

/** Una sola pregunta: ¿qué campo trae el contenido a entender?
 *  El resto se clasifica solo (fechas → ventana, prosa → citado, resto → detalles). */
export function MetadataMapForm({ storeId }: { storeId: string }) {
  const [keys, setKeys] = useState<MetadataKeyInfo[] | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    scanMetadataAction(storeId).then((r) => {
      if (!live) return;
      setLoading(false);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setKeys(r.keys);
      // Guardado manda; si no hay, sugerencia por forma.
      setContent(r.saved?.content ?? r.suggested ?? null);
      setExcluded(r.saved?.exclude ?? []);
    });
    return () => {
      live = false;
    };
  }, [storeId]);

  if (loading) return <AppCardState>Cargando campos…</AppCardState>;
  if (error || !keys) return <AppCardState tone="amber">{error ?? "Sin datos."}</AppCardState>;
  if (keys.length === 0) {
    return (
      <AppCardState>
        Tus registros no traen metadata. Cuando tu plataforma envíe campos por
        línea, vuelve aquí a elegir el del contenido.
      </AppCardState>
    );
  }

  const save = async () => {
    setSaving(true);
    const r = await saveMetadataMapAction(storeId, { content, exclude: excluded });
    setSaving(false);
    toast.add({
      title: r.ok ? "Contenido guardado" : "No se pudo guardar",
      description: r.message,
      type: r.ok ? "success" : "error",
    });
  };

  const toggleExclude = (key: string) => {
    // Excluir la elegida la desmarca como contenido (no se manda = no se entiende).
    if (content === key) setContent(null);
    setExcluded((list) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]));
  };

  return (
    <AppCard
      tone="primary"
      title="Contenido"
      description="¿Qué campo trae lo que hay que entender? Uno solo. Con “No mandar” eliges qué no llega al engine hoy."
      contentClassName="flex flex-col gap-3"
      footer={
        <span className="flex items-center gap-2">
          <Button size="sm" disabled={saving} onClick={save}>
            {saving ? "Guardando…" : "Guardar"}
          </Button>
        </span>
      }
    >
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => setContent(null)}
          className={
            content === null
              ? "rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
              : "rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground hover:bg-muted"
          }
        >
          Ninguno
        </button>
      </div>
      {keys.map((k) => {
        const activeChoice = content === k.key;
        const isExcluded = excluded.includes(k.key);
        return (
          <div key={k.key} className={`flex flex-col gap-1 rounded-lg border border-border/60 p-3 ${isExcluded ? "opacity-60" : ""}`}>
            <p className="text-sm font-medium">
              {k.samples.length > 0 ? k.samples.join(" / ") : "—"}
            </p>
            <p className="text-xs text-muted-foreground">
              <code className="rounded bg-muted px-1">{k.key}</code> · aparece en {k.freq}%
              {isExcluded ? " · no se manda" : ""}
            </p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <button
                type="button"
                disabled={isExcluded}
                onClick={() => setContent(activeChoice ? null : k.key)}
                className={
                  activeChoice
                    ? "rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
                    : "rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-40"
                }
              >
                {activeChoice ? "Elegido ✓" : "Este trae el contenido"}
              </button>
              <button
                type="button"
                onClick={() => toggleExclude(k.key)}
                className={
                  isExcluded
                    ? "rounded-full bg-amber-500/20 px-3 py-1 text-xs font-medium text-amber-600"
                    : "rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground hover:bg-muted"
                }
              >
                {isExcluded ? "Mandar igual" : "No mandar"}
              </button>
            </div>
          </div>
        );
      })}
    </AppCard>
  );
}
