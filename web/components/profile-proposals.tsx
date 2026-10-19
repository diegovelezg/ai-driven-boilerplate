"use client";

// Vigilante de perfil (#6): propuesta de corrección con decisión por delta.
// Nada se aplica solo: cada fila se acepta o se rechaza por separado.
import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppCard } from "@/components/app-card";
import {
  decideProfileDeltaAction,
  runRecalibrationAction,
} from "@/lib/profile-recalibrate/actions";
import type { ProfileProposal } from "@/lib/profile-recalibrate/service";
import type { ProfileDelta, ProfileSlot } from "@/lib/profile-recalibrate/diff";
import { ARCHETYPES, type ArchetypeId } from "@/lib/store-profiles";
import { formatNumber } from "@/lib/format";
import { verticalName } from "@/lib/taxonomy";

const SLOT_LABEL: Record<ProfileSlot, string> = {
  archetype: "Patrón de recompra",
  repurchase_cycle_days: "Recompra cada",
  taxonomy_id: "Rubro (Shopify)",
  buyer_type: "Quién te compra",
};

function formatValue(slot: ProfileSlot, v: string | null): string {
  if (v === null || v === "") return "auto / sin fijar";
  if (slot === "archetype") {
    return ARCHETYPES[v as ArchetypeId]?.label ?? v;
  }
  if (slot === "repurchase_cycle_days") return `${formatNumber(Number(v))} días`;
  if (slot === "taxonomy_id") return verticalName(v) ?? v;
  return v;
}

function DeltaRow({
  proposalId,
  delta,
  onDecided,
}: {
  proposalId: string;
  delta: ProfileDelta;
  onDecided: (msg: string) => void;
}) {
  const [pending, start] = useTransition();
  const decide = (accept: boolean) =>
    start(async () => {
      const r = await decideProfileDeltaAction(proposalId, delta.slot, accept);
      onDecided(r.message);
    });
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-input p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{SLOT_LABEL[delta.slot]}</span>
        <Badge variant="secondary">confianza {delta.confianza}</Badge>
        {delta.decision !== "pending" && (
          <Badge variant={delta.decision === "accepted" ? "default" : "outline"}>
            {delta.decision === "accepted" ? "Aplicado" : "Descartado"}
          </Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {formatValue(delta.slot, delta.de)} →{" "}
        <span className="font-medium text-foreground">
          {formatValue(delta.slot, delta.a)}
        </span>
      </p>
      <p className="text-xs text-muted-foreground">{delta.evidencia}</p>
      {delta.decision === "pending" && (
        <div className="mt-1 flex gap-2">
          <Button type="button" size="sm" disabled={pending} onClick={() => decide(true)}>
            Aceptar
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => decide(false)}
          >
            Rechazar
          </Button>
        </div>
      )}
    </div>
  );
}

export function ProfileProposalsPanel({
  proposal,
}: {
  proposal: ProfileProposal | null;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [reviewing, startReview] = useTransition();
  const runReview = () =>
    startReview(async () => {
      const r = await runRecalibrationAction();
      setMessage(r.message);
    });

  return (
    <AppCard
      title="Vigilante de perfil"
      description="Cada semana comparo tu perfil con tus datos reales. Si algo cambió, te propongo corregirlo aquí: nada se aplica sin tu decisión. La revisión tarda ~1 min en segundo plano: recarga la página para verla."
      action={proposal?.provisional ? <Badge variant="secondary">Provisional</Badge> : undefined}
      footer={
        <span className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" disabled={reviewing} onClick={runReview}>
            {reviewing ? "Revisando…" : "Revisar mi perfil"}
          </Button>
          {message && <span className="text-xs text-muted-foreground">{message}</span>}
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        {proposal ? (
          <>
            <p className="text-xs text-muted-foreground">
              Detecté cambios ({proposal.trigger.replaceAll(",", ", ")}) y el
              perfilador propone esto. Vence el{" "}
              {new Date(proposal.expiresAt).toLocaleDateString("es")}; lo que
              rechaces no se vuelve a proponer en 60 días.
            </p>
            {proposal.deltas.map((d) => (
              <DeltaRow
                key={d.slot}
                proposalId={proposal.id}
                delta={d}
                onDecided={setMessage}
              />
            ))}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Sin propuestas pendientes: tu perfil sigue representando a tu tienda.
          </p>
        )}
      </div>
    </AppCard>
  );
}
