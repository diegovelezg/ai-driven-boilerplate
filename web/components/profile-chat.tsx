"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ChatShell } from "@/components/chat/chat-shell";
import type { ChatMessage } from "@/components/chat/types";
import {
  chatProfileStepAction,
  runProfilerAction,
  type ChatMsg,
} from "@/lib/profile-actions";
import type { DescriptionInterpretation } from "@/lib/profile-interpreter";
import { verticalName } from "@/lib/taxonomy";

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
  b2c: "B2C · personas",
  b2b: "B2B · empresas",
  hybrid: "Híbrido · ambos",
};

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
  onUseDataSignal,
}: {
  storeId: string | null;
  onConfirm: (
    proposal: Proposal,
    fullDescription: string,
    info?: { criticVerdict: "accept" | "reject"; criticReasons: string[] },
  ) => void;
  onUseDataSignal: () => void;
}) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([{ role: "agent", content: GREETING }]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  // El confirmar se habilita solo cuando el servidor da done (slots agotados).
  const [canConfirm, setCanConfirm] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);
  const [deepBusy, setDeepBusy] = useState(false);

  const send = async (text: string) => {
    const trimmed = text.trim().slice(0, 2000);
    if (!trimmed || busy || deepBusy) return;
    const next: ChatMsg[] = [...msgs, { role: "user", content: trimmed }];
    setMsgs(next);
    setDraft("");
    setBusy(true);
    const res = await chatProfileStepAction(msgs, trimmed, storeId);
    setBusy(false);
    setMsgs([...next, { role: "agent", content: res.reply }]);
    if (res.proposal) setProposal(res.proposal);
    setCanConfirm(res.done);
    setMissing(res.missing);
  };

  // Confirmar = correr el set (propone ciclo/buyer/arquetipo con evidencia)
  // y avanzar con SU salida. Si el set falla, se confirma lo investigado
  // diciéndolo explícito (degradación declarada, no silenciosa).
  const confirm = async () => {
    if (!proposal || !canConfirm || deepBusy) return;
    const desc = fullDescription();
    if (!storeId) {
      onConfirm(proposal, desc);
      return;
    }
    setDeepBusy(true);
    const deep = await runProfilerAction(storeId, desc);
    setDeepBusy(false);
    if (!deep.ok || !deep.synthesis) {
      setMsgs((m) => [...m, { role: "agent", content: `No pude generar el perfil profundo (${deep.message}). Te dejo confirmar lo investigado en el chat.` }]);
      onConfirm(proposal, desc);
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
    onConfirm(bridged, desc, {
      criticVerdict: deep.criticVerdict ?? "accept",
      criticReasons: deep.criticReasons ?? [],
    });
  };
  const fullDescription = () =>
    msgs
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n");

  // El shell habla user/assistant: agent → assistant solo para pintar.
  const display: ChatMessage[] = msgs.map((m) => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.content,
  }));

  return (
    <div className="flex flex-col gap-2">
      <ChatShell
        className="max-h-96 rounded-lg border border-input"
        messages={display}
        input={draft}
        onInputChange={setDraft}
        onAsk={(t) => void send(t)}
        pending={busy || deepBusy}
        error={null}
        emptyTitle="Describe tu negocio"
        emptySubtitle={GREETING}
        placeholder="Ej. Vendo café a oficinas por suscripción, mi web es mitostaduria.pe…"
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
                {proposal.cycleDays && <li>Recompra aprox. cada {proposal.cycleDays} días</li>}
                {proposal.sourceUrl && <li>Investigué {proposal.sourceUrl}</li>}
              </ul>
              <Button
                type="button"
                size="sm"
                className="mt-2"
                disabled={!canConfirm || deepBusy}
                title={canConfirm ? "El set genera el perfil profundo (ciclo, buyer, arquetipo)" : `Falta: ${missing.map((m) => SLOT_LABEL[m] ?? m).join(", ")}`}
                onClick={() => void confirm()}
              >
                {deepBusy
                  ? "Generando perfil profundo…"
                  : canConfirm
                    ? "Generar perfil y continuar"
                    : `Falta: ${missing.map((m) => SLOT_LABEL[m] ?? m).join(", ") || "…"}`}
              </Button>
            </div>
          )
        }
      />

      <button
        type="button"
        onClick={onUseDataSignal}
        className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        Omitir y usar datos de la tienda
      </button>
    </div>
  );
}
