"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type Op = (id: string) => Promise<{ ok: boolean; message: string }>;

/** Par Aprobar/Rechazar genérico (acciones y leads). */
export function ApprovePair({
  id,
  onApprove,
  onReject,
}: {
  id: string;
  onApprove: Op;
  onReject: Op;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (fn: Op) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fn(id);
      setMsg(r.message);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex items-center gap-2">
      <Button size="sm" disabled={busy} onClick={() => run(onApprove)}>
        Aprobar
      </Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => run(onReject)}>
        Rechazar
      </Button>
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
    </span>
  );
}

export function DismissButton({ id, onDismiss }: { id: string; onDismiss: Op }) {  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onDismiss(id);
          router.refresh();
        } finally {
          setBusy(false);
        }
      }}
    >
      Descartar
    </Button>
  );
}

/** Regenera borradores con criterios viejos (los borra y redacta de nuevo). */export function RegenerateButton({
  count,
  onRegenerate,
}: {
  count: number;
  onRegenerate: () => Promise<{ ok: boolean; message: string }>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (count <= 0) return null;
  return (
    <span className="flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        title="Borra los pendientes con criterios viejos y los redacta de nuevo. No toca aprobados ni enviados."
        onClick={async () => {
          setBusy(true);
          try {
            const r = await onRegenerate();
            setMsg(r.message);
            router.refresh();
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Regenerando…" : `Regenerar ${count} con criterios actuales`}
      </Button>
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
    </span>
  );
}

/** Revoca una aprobación aún no enviada (approved → rejected). */
export function RevokeButton({ id, onRevoke }: { id: string; onRevoke: Op }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        title="Revoca la aprobación antes de que se envíe. No toca lo ya enviado."
        onClick={async () => {
          setBusy(true);
          try {
            const r = await onRevoke(id);
            setMsg(r.message);
            router.refresh();
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Revocando…" : "Revocar aprobación"}
      </Button>
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
    </span>
  );
}
