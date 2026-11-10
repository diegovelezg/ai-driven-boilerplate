"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";

/** Disparo manual del brief (mismo throttle 1x día que el cron).
 *  Sin `force`: si ya corrió hoy, avisa y no duplica. */
export function BriefRunButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function run() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/brief", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force: false }),
      });
      const j = (await res.json().catch(() => null)) as { ok?: boolean; skipped?: boolean; summary?: string; error?: string } | null;
      if (!res.ok || !j?.ok) {
        toast.add({ title: "No se pudo generar el brief", description: j?.error ?? `HTTP ${res.status}`, type: "error" });
        return;
      }
      toast.add({ title: j.skipped ? "Brief al día" : "Brief generado", description: j.summary ?? "", type: j.skipped ? "info" : "success" });
      window.dispatchEvent(new CustomEvent("inbox:update"));
      router.refresh();
    } catch (e) {
      toast.add({ title: "No se pudo generar el brief", description: e instanceof Error ? e.message : "Error de red.", type: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="outline" size="sm" disabled={busy} onClick={() => void run()} title="Genera el brief de hoy (1x día; si ya corrió, no duplica)">
      {busy ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
      {busy ? "Generando…" : "Generar brief"}
    </Button>
  );
}
