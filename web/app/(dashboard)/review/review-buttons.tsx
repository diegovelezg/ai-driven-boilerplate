"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { AppTooltip } from "@/components/ui/app-tooltip";
import { Mail, MessageCircle } from "lucide-react";
import { useBackgroundOrNull } from "@/components/background-status";
import type { ReviewOp } from "@/lib/review-actions";

type Op = (id: string) => Promise<{ ok: boolean; message: string }>;

/** Par Aprobar/Rechazar genérico (acciones y leads).
 *  `openOnApproveUrl`: solo WhatsApp manual — al aprobar se abre el chat en
 *  el mismo gesto del clic (después el popup-blocker lo frena). Si la
 *  aprobación falla, la pestaña se cierra. El lote no abre nada. */
export function ApprovePair({
  id,
  onApprove,
  onReject,
  openOnApproveUrl = null,
  channel = null,
}: {
  id: string;
  onApprove: Op;
  onReject: Op;
  openOnApproveUrl?: string | null;
  /** Muestra icono del canal en Aprobar (email = sobre, whatsapp = chat). */
  channel?: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (fn: Op) => {
    if (busy) return;
    let win: Window | null = null;
    if (fn === onApprove && openOnApproveUrl) {
      win = window.open("", "_blank", "noopener");
    }
    setBusy(true);
    try {
      const r = await fn(id);
      setMsg(r.message);
      if (win) {
        if (r.ok && openOnApproveUrl) win.location.href = openOnApproveUrl;
        else win.close();
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex items-center gap-2">
      <Button size="sm" disabled={busy} onClick={() => run(onApprove)}>
        {channel === "whatsapp" ? (
          <MessageCircle className="size-4" aria-label="WhatsApp" />
        ) : channel === "email" ? (
          <Mail className="size-4" aria-label="Email" />
        ) : null}
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
  onRegenerate: () => Promise<ReviewOp>;
}) {
  const router = useRouter();
  const bg = useBackgroundOrNull();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (count <= 0) return null;
  return (
    <span className="flex items-center gap-2">
      <AppTooltip tip="Borra los pendientes con criterios viejos y los redacta de nuevo. No toca aprobados ni enviados.">
        <span className="inline-flex items-center">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                // Por la cinta cuando hay provider: el copywriter que arranca
                // suma su chip sin esperar al refresh.
                const r = bg ? await bg.start(() => onRegenerate().then((x) => ({ ...x, run: x.run ?? null }))) : await onRegenerate();
                setMsg(r.message);
                router.refresh();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Regenerando…" : `Regenerar ${count} con criterios actuales`}
          </Button>
        </span>
      </AppTooltip>
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
    </span>
  );
}

/** Cancela un envío aún no salido (approved → rejected). */
export function RevokeButton({ id, onRevoke }: { id: string; onRevoke: Op }) {  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2">
      <AppTooltip tip="Cancela el envío antes de que salga. No toca lo ya enviado.">
        <span className="inline-flex items-center">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
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
            {busy ? "Cancelando…" : "Cancelar envío"}
          </Button>
        </span>
      </AppTooltip>
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
    </span>
  );
}

/** Cambia un pendiente al otro canal (solo si el cliente tiene ambos
 *  contactos). Re-redacta la misma fila: nunca hay dos borradores vivos. */
export function SwitchChannelButton({
  id,
  toLabel,
  onSwitch,
}: {
  id: string;
  toLabel: string;
  onSwitch: Op;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2">
      <AppTooltip tip="Re-redacta este borrador para el otro canal. Solo una versión vive a la vez.">
        <span className="inline-flex items-center">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await onSwitch(id);
                setMsg(r.message);
                router.refresh();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Cambiando…" : `Cambiar a ${toLabel}`}
          </Button>
        </span>
      </AppTooltip>
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
    </span>
  );
}

/** Marca un aprobado-WhatsApp como enviado manual (flujo wa.me). */
export function MarkSentButton({ id, onMarkSent }: { id: string; onMarkSent: Op }) {  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2">
      <AppTooltip tip="Úsalo después de enviar desde WhatsApp. Pasa a enviada y el analyst la mide.">
        <span className="inline-flex items-center">
          <Button
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await onMarkSent(id);
                setMsg(r.message);
                router.refresh();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Marcando…" : "Ya lo envié por WhatsApp"}
          </Button>
        </span>
      </AppTooltip>
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
    </span>
  );
}

type SaveOp = (id: string, subject: string | null, body: string) => Promise<{ ok: boolean; message: string }>;
/** Edición inline de asunto/cuerpo en pendientes. Topes: whatsapp ≤450,
 *  email ≤800 con asunto obligatorio. Solo guarda si cambió algo. */
export function EditableDraft({
  id,
  channel,
  subject,
  body,
  onSave,
}: {
  id: string;
  channel: string;
  subject: string | null;
  body: string;
  onSave: SaveOp;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [sSubject, setSSubject] = useState(subject ?? "");
  const [sBody, setSBody] = useState(body);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const limit = channel === "whatsapp" ? 450 : 800;
  const over = sBody.trim().length > limit;
  const unchanged = sBody === body && (channel === "whatsapp" || sSubject === (subject ?? ""));
  const canSave = !busy && !over && !unchanged;
  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    try {
      const r = await onSave(id, channel === "whatsapp" ? null : sSubject, sBody);
      setMsg(r.message);
      if (r.ok) {
        setEditing(false);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  };
  // Ctrl+Enter (o Cmd+Enter) guarda desde asunto o cuerpo.
  const saveKeys = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      void save();
    }
  };

  if (!editing) {
    return (
      <>
        {channel !== "whatsapp" && subject && (
          <p
            className="cursor-text rounded px-1 -mx-1 text-[13px] font-medium hover:bg-muted/60"
            title="Clic para editar"
            onClick={() => {
              setSSubject(subject ?? "");
              setSBody(body);
              setMsg(null);
              setEditing(true);
            }}
          >
            {subject}
          </p>
        )}
        <p
          className="cursor-text rounded px-1 -mx-1 whitespace-pre-wrap text-[13px] hover:bg-muted/60"
          title="Clic para editar"
          onClick={() => {
            setSSubject(subject ?? "");
            setSBody(body);
            setMsg(null);
            setEditing(true);
          }}
        >
          {body}
        </p>
      </>
    );
  }
  return (
    <span className="flex flex-col gap-2">
      {channel !== "whatsapp" && (
        <input
          value={sSubject}
          onChange={(e) => setSSubject(e.target.value)}
          onKeyDown={saveKeys}
          placeholder="Asunto"
          maxLength={200}
          className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-[13px] font-medium outline-none focus:border-ring"
        />
      )}
      <textarea
        value={sBody}
        onChange={(e) => setSBody(e.target.value)}
        onKeyDown={saveKeys}
        rows={5}
        className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-[13px] outline-none focus:border-ring"
      />
      <span className={`text-xs tabular-nums ${over ? "text-destructive" : "text-muted-foreground"}`}>
        {sBody.trim().length}/{limit} caracteres
      </span>
      <span className="flex items-center gap-2">
        <Button size="sm" disabled={!canSave} onClick={save} title="Ctrl+Enter">
          {busy ? "Guardando…" : "Guardar"}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(false)}>
          Cancelar
        </Button>
        {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      </span>
    </span>
  );
}

/** Fila de acciones del borrador con busy compartido: mientras corre
 *  aprobar, rechazar o cambiar de canal, todo lo demás se deshabilita.
 *  El auto-open de WhatsApp vive acá (mismo gesto del clic). */
export function DraftActions({
  id,
  channel,
  wameUrl,
  canSwitch,
  toLabel,
  onApprove,
  onReject,
  onSwitch,
}: {
  id: string;
  channel: string;
  wameUrl?: string | null;
  canSwitch: boolean;
  toLabel: string;
  onApprove: Op;
  onReject: Op;
  onSwitch: Op;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "approve" | "reject" | "switch">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const done = (message: string) => {
    setMsg(message);
    setBusy(null);
    router.refresh();
  };
  const approve = async () => {
    if (busy) return;
    let win: Window | null = null;
    if (channel === "whatsapp" && wameUrl) {
      win = window.open("", "_blank", "noopener");
    }
    setBusy("approve");
    try {
      const r = await onApprove(id);
      if (win) {
        if (r.ok && wameUrl) win.location.href = wameUrl;
        else win.close();
      }
      done(r.message);
    } catch (e) {
      win?.close();
      done(e instanceof Error ? e.message : "Error");
    }
  };
  const reject = async () => {
    if (busy) return;
    setBusy("reject");
    try {
      const r = await onReject(id);
      done(r.message);
    } catch (e) {
      done(e instanceof Error ? e.message : "Error");
    }
  };
  const switchChannel = async () => {
    if (busy) return;
    setBusy("switch");
    try {
      const r = await onSwitch(id);
      // En éxito no hay mensaje: el canal visible ya cambió y el texto
      // inline ("Ahora en Email") movía los botones. Solo se avisa el fallo.
      if (!r.ok) setMsg(r.message);
      setBusy(null);
      router.refresh();
    } catch (e) {
      done(e instanceof Error ? e.message : "Error");
    }
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="flex items-center gap-2">
        <Button size="sm" disabled={busy !== null} onClick={approve}>
          {channel === "whatsapp" ? (
            <MessageCircle className="size-4" aria-label="WhatsApp" />
          ) : channel === "email" ? (
            <Mail className="size-4" aria-label="Email" />
          ) : null}
          {busy === "approve" ? "Aprobando…" : "Aprobar"}
        </Button>
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={reject}>
          {busy === "reject" ? "Rechazando…" : "Rechazar"}
        </Button>
      </span>
      {canSwitch && (
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={switchChannel}>
          {busy === "switch" ? "Cambiando…" : `Cambiar a ${toLabel}`}
        </Button>
      )}
      {channel === "whatsapp" && !wameUrl && (
        <span className="text-xs text-muted-foreground">Sin teléfono válido: pide la versión email.</span>
      )}
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
    </div>
  );
}
