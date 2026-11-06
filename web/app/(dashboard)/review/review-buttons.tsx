"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { AppTooltip } from "@/components/ui/app-tooltip";
import { Binoculars, Mail, MessageCircle } from "lucide-react";
import { useBackgroundOrNull } from "@/components/background-status";
import { toast } from "@/components/ui/toast";
import type { ReviewOp } from "@/lib/review-actions";
import { formatNumber } from "@/lib/format";

type Op = (id: string) => Promise<{ ok: boolean; message: string }>;

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

/** Lanza una prospección manual (botón del inbox). Mismo tratamiento SSOT
 *  que Enriquecer: `bg.start()` y la cinta avisa; solo se toastea el
 *  error sin run. Pasa el tope del auto: el tope solo frena la mañana. */
export function ProspectButton({
  onProspect,
}: {
  onProspect: () => Promise<ReviewOp>;
}) {
  const router = useRouter();
  const bg = useBackgroundOrNull();
  const prospectRun = bg?.activeRuns.find((r) => r.kind === "prospect") ?? null;
  const running = prospectRun !== null;
  const blocked = !running && (bg?.isBusy("prospect") ?? false);
  const busy = (bg?.starting ?? false) || running || blocked;
  if (!bg) {
    return (
      <span className="flex items-center gap-2">
        <AppTooltip tip="Busca empresas parecidas a tu ideal ahora (tarda minutos). Vale aunque haya tope: el tope solo pausa el automático.">
          <span className="inline-flex items-center">
            <Button size="sm" onClick={async () => {
              try {
                const r = await onProspect();
                toast.add({
                  title: r.ok ? "Prospección iniciada" : "No se pudo prospectar",
                  description: r.message,
                  type: r.ok ? "success" : "error",
                });
                router.refresh();
              } catch (e) {
                toast.add({
                  title: "No se pudo prospectar",
                  description: e instanceof Error ? e.message : "Error inesperado.",
                  type: "error",
                });
              }
            }}>
              <Binoculars aria-hidden />
              Buscar más empresas
            </Button>
          </span>
        </AppTooltip>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <AppTooltip tip="Busca empresas parecidas a tu ideal ahora (tarda minutos). Vale aunque haya tope: el tope solo pausa el automático.">
        <span className="inline-flex items-center">
          <Button
            size="sm"
            disabled={busy}
            onClick={async () => {
              try {
                const r = await bg.start(() => onProspect().then((x) => ({ ...x, run: x.run ?? null })));
                // Con run la cinta ya avisa; sin run avisar aquí.
                if (!r.ok && !r.run) toast.add({
                  title: "No se pudo prospectar",
                  description: r.message,
                  type: "error",
                });
              } catch (e) {
                toast.add({
                  title: "No se pudo prospectar",
                  description: e instanceof Error ? e.message : "Error inesperado.",
                  type: "error",
                });
              }
            }}
          >
            <Binoculars aria-hidden />
            {running ? "Buscando…" : "Buscar más empresas"}
          </Button>
        </span>
      </AppTooltip>
    </span>
  );
}

/** Marca un lead como contactado (lo contactaste por tu cuenta). */
export function MarkContactedButton({ id, onMarkContacted }: { id: string; onMarkContacted: Op }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <span className="flex items-center gap-2">
      <AppTooltip tip="Ya lo contactaste por email, teléfono o RRSS. Cierra el loop: no vuelve a pendientes.">
        <span className="inline-flex items-center">
          <Button
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await onMarkContacted(id);
                toast.add({
                  title: r.ok ? "Marcado como contactado" : "No se pudo marcar",
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
            {busy ? "Marcando…" : "Contactado"}
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

/** Rescata un mensaje rechazado/cancelado (rejected → pending_review).
 *  Nada desaparece: vuelve a Clientes por contactar. */
export function RescueButton({ id, onRescue }: { id: string; onRescue: Op }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <span className="flex items-center gap-2">
      <AppTooltip tip="Rescata el mensaje: vuelve a Clientes por contactar.">
        <span className="inline-flex items-center">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await onRescue(id);
                toast.add({
                  title: r.ok ? "Rescatado" : "No se pudo rescatar",
                  description: r.message,
                  type: r.ok ? "success" : "error",
                });
                router.refresh();
              } catch (e) {
                toast.add({
                  title: "No se pudo rescatar",
                  description: e instanceof Error ? e.message : "Error inesperado.",
                  type: "error",
                });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Rescatando…" : "Rescatar"}
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
    // WhatsApp se abre EN el gesto del clic (síncrono): abrir un blank y
    // redirigirlo tras el `await` lo bloquea el navegador y deja la pestaña
    // en blanco. Si el approve falla, el tab ya abierto es inofensivo
    // (texto prellenado, nada se envía solo).
    if (channel === "whatsapp" && wameUrl) {
      window.open(wameUrl, "_blank", "noopener");
    }
    setBusy("approve");
    try {
      const r = await onApprove(id);
      toast.add({
        title: r.ok ? "Aprobado" : "No se pudo aprobar",
        description: r.message,
        type: r.ok ? "success" : "error",
      });
      setBusy(null);
      router.refresh();
    } catch (e) {
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
        title: r.ok ? "Descartado" : "No se pudo descartar",
        description: r.message,
        type: r.ok ? "success" : "error",
      });
      setBusy(null);
      router.refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Error";
      toast.add({ title: "No se pudo descartar", description: message, type: "error" });
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
    toast.add({
      id: loadingId,
      title: `Cambiando a ${toLabel}…`,
      description: "Preparando mensaje apropiado para ese canal…",
      type: "loading",
    });
    try {
      const r = await onSwitch(id);
      toast.close(loadingId);
      toast.add({
        title: r.ok ? `Cambiado a ${toLabel}` : `No se pudo cambiar a ${toLabel}`,
        description: r.message,
        type: r.ok ? "success" : "error",
      });
      setBusy(null);
      router.refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Error";
      toast.close(loadingId);
      toast.add({ title: `No se pudo cambiar a ${toLabel}`, description: message, type: "error" });
      setBusy(null);
      router.refresh();
    }
  };
  const isWa = channel === "whatsapp";
  const approveLabel = isWa ? "Abrir en WhatsApp" : "Aprobar y enviar";
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="flex items-center gap-2">
        <Button size="sm" disabled={busy !== null} onClick={approve}>
          {channel === "whatsapp" ? (
            <MessageCircle className="size-4" aria-label="WhatsApp" />
          ) : channel === "email" ? (
            <Mail className="size-4" aria-label="Email" />
          ) : null}
          {busy === "approve" ? (isWa ? "Abriendo…" : "Enviando…") : approveLabel}
        </Button>
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={reject}>
          {busy === "reject" ? "Descartando…" : "Descartar"}
        </Button>
      </span>
      {canSwitch && (
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={switchChannel}>
          {busy === "switch" ? `Cambiando a ${toLabel}…` : `Cambiar a ${toLabel}`}
        </Button>
      )}
      {channel === "whatsapp" && !wameUrl && (
        <span className="text-xs text-muted-foreground">Sin teléfono válido: pide la versión email.</span>
      )}
    </div>
  );
}
