"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";

/** Descarga /api/export con los filtros actuales de la vista.
 *  Fetch→blob (no `<a download>` directo): un 403/500 se muestra con toast
 *  en vez de descargarse como `.csv` con el texto del error. */
export function ExportCsvButton({ href, label = "Exportar CSV" }: { href: string; label?: string }) {
  const [pending, setPending] = useState(false);

  async function download() {
    if (pending) return;
    setPending(true);
    try {
      const res = await fetch(href);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const msg =
          res.status === 403
            ? "Sin acceso a esta tienda."
            : res.status === 429
              ? "Demasiadas descargas. Espera un momento."
              : text.trim().slice(0, 160) || `No se pudo exportar (HTTP ${res.status}).`;
        toast.add({ title: "No se pudo exportar", description: msg, type: "error" });
        return;
      }
      if (res.headers.get("X-Export-Truncated") === "1") {
        toast.add({
          title: "Export parcial",
          description: "Hay más de 200 filas: se exportaron las primeras. Refina el filtro.",
          type: "error",
        });
      }
      const blob = await res.blob();
      const cd = res.headers.get("content-disposition") ?? "";
      const m = /filename\*=UTF-8''([^;]+)|filename="([^"]+)"/.exec(cd);
      const filename = decodeURIComponent(m?.[1] ?? m?.[2] ?? "export.csv");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      toast.add({ title: "No se pudo exportar", description: "Error de red.", type: "error" });
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      title={label}
      aria-label={label}
      disabled={pending}
      onClick={download}
    >
      <Download aria-hidden />
      {pending ? "Exportando…" : "CSV"}
    </Button>
  );
}
