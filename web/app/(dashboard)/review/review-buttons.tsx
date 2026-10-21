"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { AppTooltip } from "@/components/ui/app-tooltip";
import { Mail, MessageCircle } from "lucide-react";
import { useBackgroundOrNull } from "@/components/background-status";
import { toast } from "@/components/ui/toast";
import type { ReviewOp } from "@/lib/review-actions";
import { formatNumber } from "@/lib/format";

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
  const [busy, setBusy] = useState<null | "approve" | "reject">(null);
  const run = async (fn: Op, kind: "approve" | "reject") => {
    if (busy) return;
    let win: Window | null = null;
    if (fn === onApprove && openOnApproveUrl) {
      win = window.open("", "_blank", "noopener");
    }
    setBusy(kind);
    try {
      const r = await fn(id);
      toast.add({
        title: kind === "approve" ? (r.ok ? "Aprobado" : "No se pudo aprobar") : r.ok ? "Rechazado" : "No se pudo rechazar",
        description: r.message,
        type: r.ok ? "success" : "error",
      });
      if (win) {
        if (r.ok && openOnApproveUrl) win.location.href = openOnApproveUrl;
        else win.close();
      }
      router.refresh();
    } catch (e) {
      win?.close();
      toast.add({
        title: kind === "approve" ? "No se pudo aprobar" : "No se pudo rechazar",
        description: e instanceof Error ? e.message : "Error inesperado.",
        type: "error",
      });
    } finally {
      setBusy(null);
    }
  };
  return (
    <span className="flex items-center gap-2">
      <Button size="sm" disabled={busy !== null} onClick={() => run(onApprove, "approve")}>
        {channel === "whatsapp" ? (
          <MessageCircle className="size-4" aria-label="WhatsApp" />
        ) : channel === "email" ? (
          <Mail className="size-4" aria-label="Email" />
        ) : null}
        {busy === "approve" ? "Aprobando…" : "Aprobar"}
      </Button>
      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run(onReject, "reject")}>
        {busy === "reject" ? "Rechazando…" : "Rechazar"}
      </Button>
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
          const r = await onDismiss(id);
          toast.add({
            title: r.ok ? "Descartado" : "No se pudo descartar",
            description: r.message,
            type: r.ok ? "success" : "error",
          });
          router.refresh();
        } catch (e) {
          toast.add({
            title: "No se pudo descartar",
            description: e instanceof Error ? e.message : "Error inesperado.",
            type: "error",
          });
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Descartando…" : "Descartar"}
    </Button>
  );
}

/** Redacta un borrador para una señal sin mensaje (el inbox es el backlog:
 *  todo se gestiona aquí, no en el home). */
export function RedactButton({ id, onRedact }: { id: string; onRedact: (sid: string) => Promise<ReviewOp> }) {
  const router = useRouter();
  const bg = useBackgroundOrNull();
  const [busy, setBusy] = useState(false);
  return (
    <span className="flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            if (bg) {
              const r = await bg.start(async () => {
                const x = await onRedact(id);
                return { ok: x.ok, message: x.message, run: x.run ?? null };
              });
              // Con run la cinta ya avisa; sin run avisar aquí (veto/duplicado rápido).
              if (!r.run) {
                toast.add({
                  title: r.ok ? "Borrador redactado" : "No se pudo redactar",
                  description: r.message,
                  type: r.ok ? "success" : "error",
                });
              }
            } else {
              const r = await onRedact(id);
              toast.add({
                title: r.ok ? "Borrador redactado" : "No se pudo redactar",
                description: r.message,
                type: r.ok ? "success" : "error",
              });
              router.refresh();
            }
          } catch (e) {
            toast.add({
              title: "No se pudo redactar",
              description: e instanceof Error ? e.message : "Error inesperado.",
              type: "error",
            });
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Redactando…" : "Redactar"}
      </Button>
    </span>
  );
}

/** Reabre una señal descartada ("contactar igual", issue #14 B3): el descarte
 *  la escondía 30d sin remedio; reabrir la devuelve a la cola. */
export function ReopenButton({ id, onReopen }: { id: string; onReopen: Op }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <span className="flex items-center gap-2">
      <AppTooltip tip="Reabre la señal descartada: vuelve a la cola del motor para contactar igual.">
        <span className="inline-flex items-center">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await onReopen(id);
                toast.add({
                  title: r.ok ? "Señal reabierta" : "No se pudo reabrir",
                  description: r.message,
                  type: r.ok ? "success" : "error",
                });
                router.refresh();
              } catch (e) {
                toast.add({
                  title: "No se pudo reabrir",
                  description: e instanceof Error ? e.message : "Error inesperado.",
                  type: "error",
                });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Reabriendo…" : "Contactar igual"}
          </Button>
        </span>
      </AppTooltip>
    </span>
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
  if (count <= 0) return null;
  return (
    <span className="flex items-center gap-2">
      <AppTooltip tip="Borra los pendientes con criterios viejos y los redacta de nuevo con el copywriter actual (v1 + legacy con señal). Sin señal se purgan: no se pueden redactar ni enviar. No toca aprobados ni enviados.">
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
                // Con run la cinta ya avisa; sin run (o sin bg) avisar aquí.
                if (!bg || !r.run) toast.add({
                  title: r.ok ? "Borradores regenerados" : "No se pudo regenerar",
                  description: r.message,
                  type: r.ok ? "success" : "error",
                });
                // `bg.start()` ya refrescó; repetirlo aborta el RSC en vuelo.
                if (!bg) router.refresh();
              } catch (e) {
                toast.add({
                  title: "No se pudo regenerar",
                  description: e instanceof Error ? e.message : "Error inesperado.",
                  type: "error",
                });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Regenerando…" : `Regenerar ${formatNumber(count)} con criterios actuales`}
          </Button>
        </span>
      </AppTooltip>
    </span>
  );
}

/** Cancela un envío aún no salido (approved → rejected). */
export function RevokeButton({ id, onRevoke }: { id: string; onRevoke: Op }) {  const router = useRouter();
  const [busy, setBusy] = useState(false);
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
                toast.add({
                  title: r.ok ? "Envío cancelado" : "No se pudo cancelar",
                  description: r.message,
                  type: r.ok ? "success" : "error",
                });
                router.refresh();
              } catch (e) {
                toast.add({
                  title: "No se pudo cancelar",
                  description: e instanceof Error ? e.message : "Error inesperado.",
                  type: "error",
                });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Cancelando…" : "Cancelar envío"}
          </Button>
        </span>
      </AppTooltip>
    </span>
  );
}

/** Marca un aprobado-WhatsApp como enviado manual (flujo wa.me). */
export function MarkSentButton({ id, onMarkSent }: { id: string; onMarkSent: Op }) {  const router = useRouter();
  const [busy, setBusy] = useState(false);
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
                toast.add({
                  title: r.ok ? "Marcado como enviado" : "No se pudo marcar",
                  description: r.message,
                  type: r.ok ? "success" : "error",
                });
                router.refresh();
              } catch (e) {
                toast.add({
                  title: "No se pudo marcar",
                  description: e instanceof Error ? e.message : "Error inesperado.",
                  type: "error",
                });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Marcando…" : "Ya lo envié por WhatsApp"}
          </Button>
        </span>
      </AppTooltip>
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
  const limit = channel === "whatsapp" ? 450 : 800;
  const over = sBody.trim().length > limit;
  const unchanged = sBody === body && (channel === "whatsapp" || sSubject === (subject ?? ""));
  const canSave = !busy && !over && !unchanged;
  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    try {
      const r = await onSave(id, channel === "whatsapp" ? null : sSubject, sBody);
      toast.add({
        title: r.ok ? "Borrador guardado" : "No se pudo guardar",
        description: r.message,
        type: r.ok ? "success" : "error",
      });
      if (r.ok) {
        setEditing(false);
        router.refresh();
      }
    } catch (e) {
      toast.add({
        title: "No se pudo guardar",
        description: e instanceof Error ? e.message : "Error inesperado.",
        type: "error",
      });
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
          <AppTooltip tip="Clic para editar">
            <p
              className="cursor-text rounded px-1 -mx-1 text-[13px] font-medium hover:bg-muted/60"
              onClick={() => {
                setSSubject(subject ?? "");
                setSBody(body);
                setEditing(true);
              }}
            >
              {subject}
            </p>
          </AppTooltip>
        )}
        <AppTooltip tip="Clic para editar">
          <p
            className="cursor-text rounded px-1 -mx-1 whitespace-pre-wrap text-[13px] hover:bg-muted/60"
            onClick={() => {
              setSSubject(subject ?? "");
              setSBody(body);
              setEditing(true);
            }}
          >
            {body}
          </p>
        </AppTooltip>
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
        {formatNumber(sBody.trim().length)}/{formatNumber(limit)} caracteres
      </span>
      <span className="flex items-center gap-2">
        <AppTooltip tip="Ctrl+Enter">
          <span className="inline-flex items-center">
            <Button size="sm" disabled={!canSave} onClick={save}>
              {busy ? "Guardando…" : "Guardar"}
            </Button>
          </span>
        </AppTooltip>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(false)}>
          Cancelar
        </Button>
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
      toast.add({
        title: r.ok ? "Aprobado" : "No se pudo aprobar",
        description: r.message,
        type: r.ok ? "success" : "error",
      });
      setBusy(null);
      router.refresh();
    } catch (e) {
      win?.close();
      const message = e instanceof Error ? e.message : "Error";
      toast.add({ title: "No se pudo aprobar", description: message, type: "error" });
      setBusy(null);
      router.refresh();
    }
  };
  const reject = async () => {
    if (busy) return;
    setBusy("reject");
    try {
      const r = await onReject(id);
      toast.add({
        title: r.ok ? "Rechazado" : "No se pudo rechazar",
        description: r.message,
        type: r.ok ? "success" : "error",
      });
      setBusy(null);
      router.refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Error";
      toast.add({ title: "No se pudo rechazar", description: message, type: "error" });
      setBusy(null);
      router.refresh();
    }
  };
  const switchChannel = async () => {
    if (busy) return;
    setBusy("switch");
    // Feedback inmediato: la re-redacción usa LLM reasoning y tarda
    // decenas de segundos; sin esto el botón parece muerto. Se cierra al
    // resolver (add + close, sin update: el update vive solo en la cinta).
    const loadingId = `switch-${id}`;
    toast.close(loadingId);
    toast.add({ id: loadingId, title: "Cambiando de canal…", type: "loading" });
    try {
      const r = await onSwitch(id);
      toast.close(loadingId);
      toast.add({
        title: r.ok ? "Canal cambiado" : "No se pudo cambiar",
        description: r.message,
        type: r.ok ? "success" : "error",
      });
      setBusy(null);
      router.refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Error";
      toast.close(loadingId);
      toast.add({ title: "No se pudo cambiar", description: message, type: "error" });
      setBusy(null);
      router.refresh();
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
    </div>
  );
}
