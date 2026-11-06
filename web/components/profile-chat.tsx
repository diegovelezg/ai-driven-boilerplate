"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { AppTooltip } from "@/components/ui/app-tooltip";
import { ChatShell } from "@/components/chat/chat-shell";
import type { ChatMessage } from "@/components/chat/types";
import { useBackgroundOrNull } from "@/components/background-status";
import {
  chatProfileStepAction,
  runProfilerAction,
  type ChatMsg,
  type DeepProfileState,
} from "@/lib/profile-actions";
import type { DescriptionInterpretation } from "@/lib/profile-interpreter";
import { toast } from "@/components/ui/toast";
import { verticalName } from "@/lib/taxonomy";
import { formatNumber } from "@/lib/format";

type Proposal = DescriptionInterpretation & {
  sourceUrl: string | null;
  taxonomyId: string | null;
};

const SLOT_LABEL: Record<string, string> = {
  business_model: "quién te compra",
  vertical: "tu rubro",
  cycle_days: "ciclo de recompra",
  buyer_type: "tipo de comprador",
};

const MODEL_LABEL: Record<string, string> = {
  b2c: "B2B · empresas",
  b2b: "B2B · empresas",
  hybrid: "B2B · empresas",
};

/** Sin SSE aquí (server actions): etapas rotadas por tiempo mientras trabaja. */
const INVESTIGATING_STAGES = [
  "Investigando tu web…",
  "Cruzando tus datos reales…",
  "Afinando la propuesta…",
];
const GENERATING_STAGES = [
  "Generando tu perfil profundo…",
  "Cruzando ciclo y arquetipo…",
  "Cerrando el paso 2…",
];

const GREETING =
  "Cuéntame qué vendes y a quién. Si tienes web, pégala que la investigo yo.";

/**
 * Paso 1 del perfil: chat mínimo. El merchant habla, el servidor investiga
 * (web + LLM) y o pregunta lo que falta o propone el perfil para confirmar.
 * Un solo camino: escribir → confirmar propuesta (o omitir por datos).
 * Usa el ChatShell SSOT para burbujas/input; solo el transporte
 * (server actions) y la tarjeta de propuesta son propios.
 */
export function ProfileChat({
  storeId,
  onConfirm,
  onBusyChange,
  disabled = false,
}: {
  storeId: string | null;
  onConfirm: (
    proposal: Proposal,
    fullDescription: string,
    info?: { criticVerdict: "accept" | "reject"; criticReasons: string[] },
  ) => void;
  onBusyChange?: (busy: boolean) => void;
  /** Perfil ya completado: input y propuesta bloqueados hasta Editar. */
  disabled?: boolean;
}) {
  // Vacío inicial a propósito: el empty state del shell (título + ejemplos
  // tocables) es lo que invita a conversar; pre-sembrar el saludo lo mataba.
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  // El confirmar se habilita solo cuando el servidor da done (slots agotados).
  const [canConfirm, setCanConfirm] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);
  const [deepBusy, setDeepBusy] = useState(false);
  const bg = useBackgroundOrNull();

  // El padre bloquea salidas del paso (Editar valores) mientras el chat
  // investiga o el set genera el perfil profundo.
  const chatBusy = busy || deepBusy;
  useEffect(() => {
    onBusyChange?.(chatBusy);
  }, [chatBusy, onBusyChange]);

  // Rotación descriptiva por etapa (sin SSE en server actions).
  const [stage, setStage] = useState(0);
  useEffect(() => {
    if (!chatBusy) return;
    setStage(0);
    const t = setInterval(() => setStage((s) => s + 1), 4000);
    return () => clearInterval(t);
  }, [chatBusy]);
  const stages = deepBusy ? GENERATING_STAGES : INVESTIGATING_STAGES;
  const stageLabel = chatBusy ? stages[stage % stages.length] : null;

  const send = async (text: string) => {
    const trimmed = text.trim().slice(0, 2000);
    if (!trimmed || busy || deepBusy || disabled) return;
    const next: ChatMsg[] = [...msgs, { role: "user", content: trimmed }];
    // Placeholder vacío: el shell pinta la burbuja con los 3 puntos mientras
    // el agente investiga web + LLM (~11s). Sin esto solo quedaba un texto
    // tenue y el chat parecía muerto.
    setMsgs([...next, { role: "agent", content: "" }]);
    setDraft("");
    setBusy(true);
    try {
      const res = await chatProfileStepAction(msgs, trimmed, storeId);
      setMsgs([...next, { role: "agent", content: res.reply }]);
      if (res.proposal) setProposal(res.proposal);
      setCanConfirm(res.done);
      setMissing(res.missing);
    } catch (e) {
      // Sin esto, una excepción dejaba los puntos para siempre + input
      // bloqueado (busy nunca bajaba).
      setMsgs([
        ...next,
        {
          role: "agent",
          content: `Se cortó la investigación (${e instanceof Error ? e.message : "error"}). Reintenta tu mensaje.`,
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  // Confirmar = correr el set (propone ciclo/buyer/arquetipo con evidencia)
  // y avanzar con SU salida. Si el set falla, se confirma lo investigado
  // diciéndolo explícito (degradación declarada, no silenciosa).
  const confirm = async () => {
    if (!proposal || !canConfirm || deepBusy || disabled) return;
    const desc = fullDescription();
    if (!storeId) {
      onConfirm(proposal, elaborate(desc, proposal));
      return;
    }
    setDeepBusy(true);
    try {
      // Con cinta: la corrida `profile` muestra el avance por etapa abajo a
      // la derecha; igual se necesita la síntesis síncrona para el paso 2.
      // Sin cinta (fallback): toast loading manual de cierre explícito.
      let deep: DeepProfileState;
      if (bg) {
        let captured: DeepProfileState | null = null;
        await bg.start(async () => {
          captured = await runProfilerAction(storeId, desc);
          return { ok: captured.ok, message: captured.message, run: captured.run ?? null };
        });
        deep = captured ?? { ok: false, message: "Sin respuesta del generador." };
      } else {
        const profilerToastId = toast.add({
          title: "Generando perfil profundo",
          description: "El set cruza tu descripción con tus datos reales.",
          type: "loading",
          timeout: 0,
        });
        try {
          deep = await runProfilerAction(storeId, desc);
        } finally {
          toast.close(profilerToastId);
        }
      }
      if (!deep.ok || !deep.synthesis) {
        setMsgs((m) => [...m, { role: "agent", content: `No pude generar el perfil profundo (${deep.message}). Te dejo confirmar lo investigado en el chat.` }]);
        onConfirm(proposal, elaborate(desc, proposal));
        return;
      }
      const s = deep.synthesis;
      // Puente set → formulario (la Synthesis no trae industry/understood/
      // cycleUnknown: se derivan aquí, explícito, sin inventar).
      const bridged: Proposal = {
        businessModel: s.businessModel,
        vertical: s.vertical,
        buyerType: s.buyerType,
        cycleUnknown: false,
        cycleDays: s.cycleDays,
        industry: verticalName(s.taxonomyId),
        catalogType: s.catalogType,
        archetype: s.archetype,
        companyRequired: s.companyRequired,
        confidence: s.confidence,
        understood: s.evidence.map((e) => `${e.slot}: ${e.value}`).slice(0, 4),
        questions: s.questions,
        sourceUrl: null,
        taxonomyId: s.taxonomyId,
      };
      onConfirm(bridged, elaborate(desc, bridged), {
        criticVerdict: deep.criticVerdict ?? "accept",
        criticReasons: deep.criticReasons ?? [],
      });
    } catch (e) {
      // Sin esto, una excepción del action quedaba en silencio: toast
      // cerrado, sin avance al paso 2 y sin mensaje.
      setMsgs((m) => [
        ...m,
        {
          role: "agent",
          content: `Falló el generador (${e instanceof Error ? e.message : "error"}). Puedes reintentar con el botón o seguir con lo investigado.`,
        },
      ]);
    } finally {
      setDeepBusy(false);
    }
  };
  const fullDescription = () =>
    msgs
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n");

  // Lo que se guarda en el perfil: palabras del merchant + lo elaborado por
  // la IA (hechos entendidos, web investigada). Antes solo viajaban las
  // líneas crudas del usuario y la elaboración se perdía.
  const elaborate = (base: string, p: Proposal) =>
    [
      base,
      p.understood.length > 0 ? `El set entendió: ${p.understood.join(" · ")}.` : "",
      p.sourceUrl ? `Web investigada: ${p.sourceUrl}.` : "",
    ]
      .filter(Boolean)
      .join("\n");

  // El shell habla user/assistant: agent → assistant solo para pintar.
  const display: ChatMessage[] = msgs.map((m, i) => ({
    id: `profile-${i}`,
    role: m.role === "user" ? "user" : "assistant",
    content: m.content,
  }));

  return (
    <div className="flex flex-col gap-2">
      {disabled && (
        <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          Perfil completado. Pulsa Editar para describir un cambio.
        </p>
      )}
      <ChatShell
        className="max-h-96 rounded-lg border border-input"
        messages={display}
        input={draft}
        onInputChange={setDraft}
        onAsk={(t) => void send(t)}
        pending={busy || deepBusy}
        error={null}
        status={stageLabel}
        disabled={disabled}
        emptyTitle="Describe tu negocio"
        emptySubtitle={GREETING}
        placeholder={
          disabled
            ? "Perfil completado — pulsa Editar para cambiarlo…"
            : "Ej. Vendo café a oficinas por suscripción, mi web es mitostaduria.pe…"
        }
        inputAriaLabel="Describe tu negocio"
        thinkingLabel="Investigando…"
        belowMessages={
          proposal && (
            <div className="mx-auto mt-4 w-full max-w-[95%] rounded-lg border border-input p-3 text-xs">
              <p className="font-medium">
                Propuesta{proposal.confidence ? ` (confianza ${proposal.confidence})` : ""}:
              </p>
              <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                <li>Vendes a: {proposal.businessModel ? MODEL_LABEL[proposal.businessModel] : "—"}</li>
                <li>
                  Te dedicas a: {proposal.vertical ?? "—"}
                  {proposal.taxonomyId && verticalName(proposal.taxonomyId)
                    ? ` (${verticalName(proposal.taxonomyId)})`
                    : ""}
                </li>
                {proposal.buyerType && <li>Quién compra: {proposal.buyerType}</li>}
                {proposal.cycleDays && <li>Recompra aprox. cada {formatNumber(proposal.cycleDays)} días</li>}
                {proposal.sourceUrl && <li>Investigué {proposal.sourceUrl}</li>}
              </ul>
              <AppTooltip
                tip={canConfirm ? "El set genera el perfil profundo (ciclo, buyer, arquetipo)" : `Falta: ${missing.map((m) => SLOT_LABEL[m] ?? m).join(", ")}`}
              >
                <span className="inline-flex">
                  <Button
                    type="button"
                    size="sm"
                    className="mt-2"
                    disabled={!canConfirm || deepBusy || disabled}
                    onClick={() => void confirm()}
                  >
                    {deepBusy
                      ? "Generando perfil profundo…"
                      : canConfirm
                        ? "Generar perfil y continuar"
                        : `Falta: ${missing.map((m) => SLOT_LABEL[m] ?? m).join(", ") || "…"}`}
                  </Button>
                </span>
              </AppTooltip>
            </div>
          )
        }
      />

    </div>
  );
}
