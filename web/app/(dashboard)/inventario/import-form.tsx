"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  commitCsvTextImportAction,
  commitSheetUrlImportAction,
  previewSheetImportAction,
  type ImportState,
} from "@/lib/dooh-import-actions";
import type { ImportKind } from "@/lib/sheet-import";

export function ImportForm({
  templates,
  labels,
}: {
  templates: Record<ImportKind, string>;
  labels: Record<ImportKind, string>;
}) {
  const [kind, setKind] = useState<ImportKind>("companies");
  const [url, setUrl] = useState("");
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<ImportState | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs">
          Tipo
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as ImportKind)}
            className="h-8 rounded-lg border border-border bg-background px-2 text-sm"
          >
            {(Object.keys(labels) as ImportKind[]).map((k) => (
              <option key={k} value={k}>
                {labels[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-80 flex-1 flex-col gap-1 text-xs">
          Google Sheet URL
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://docs.google.com/spreadsheets/d/…"
            className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm"
          />
        </label>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || !url.trim()}
          onClick={() => start(async () => setResult(await previewSheetImportAction({ kind, url })))}
        >
          {pending ? "…" : "Previsualizar URL"}
        </Button>
        <Button
          size="sm"
          disabled={pending || !url.trim()}
          onClick={() => start(async () => setResult(await commitSheetUrlImportAction({ kind, url })))}
        >
          {pending ? "…" : "Importar URL"}
        </Button>
      </div>

      <label className="flex flex-col gap-1 text-xs">
        …o pega CSV directamente
        <textarea
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          rows={5}
          placeholder={templates[kind]}
          className="rounded-lg border border-border bg-background p-2.5 font-mono text-xs"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setCsv(templates[kind])}>
          Cargar plantilla {kind}
        </Button>
        <Button
          size="sm"
          disabled={pending || !csv.trim()}
          onClick={() => start(async () => setResult(await commitCsvTextImportAction({ kind, csv })))}
        >
          {pending ? "…" : "Importar CSV"}
        </Button>
      </div>

      {result && (
        <div className="rounded-lg border border-border p-3 text-sm">
          <p className={result.ok ? "text-green-600" : "text-amber-600"}>{result.message}</p>
          {result.errors && result.errors.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-xs text-muted-foreground">
              {result.errors.map((e, i) => (
                <li key={i}>
                  fila {e.row}: {e.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
