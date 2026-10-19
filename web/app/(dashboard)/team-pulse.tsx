import Link from "next/link";
import {
  Brain,
  ListChecks,
  PenLine,
  Radar,
  Send,
  TrendingUp,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { CardContent } from "@/components/ui/card";
import { ClickStop } from "./ask-agent";

type Status = "needs" | "active" | "paused";

interface PulseRow {
  id: string;
  name: string;
  icon: LucideIcon;
  status: Status;
  headline: string;
  why: string;
  href?: string;
  cta?: string;
}

export interface TeamPulseProps {
  teamVertical: string | null;
  teamCycle: number | null;
  teamConfidence: string | null;
  learnedAgo: string | null;
  needsRecheck: boolean;
  totalVigilados: number;
  hoyActuar: number;
  hoyVigilar: number;
  hasMotor: boolean;
  atRisk: number;
  topLeadName: string | null;
  pending: number;
  approved: number;
  dispatched: number;
  leadsPending: number;
  converted: number;
  recoveredLabel: string;
  reviewHref: string;
  leadsHref: string;
  settingsHref: string;
  lastActionAgo: string | null;
  runAgos: Record<string, string | null>;
  /** Última conclusión declarada por cada worker (SSOT histórica). La vista en
   *  vivo (conteos) manda; esto distingue "pausa intencional" de "nunca corrió". */
  pulseStates?: Record<string, "needs" | "active" | "paused" | null>;
  /** Corridas en curso ahora (Fase 4): tira separada "En curso", sin tocar
   *  el pulso (que es outcome, no actividad). */
  runningLabels?: string[];
}

const dotCls: Record<Status, string> = {
  needs: "bg-amber-500",
  active: "bg-emerald-500",
  paused: "bg-muted-foreground/30",
};

const priority: Record<Status, number> = { needs: 0, active: 1, paused: 2 };

function buildRows(p: TeamPulseProps): PulseRow[] {
  const rows: PulseRow[] = [];
  const agoSuffix = (k: string) => (p.runAgos[k] ? ` · ${p.runAgos[k]}` : "");

  // Cerebro: no corre diario, su pausa es normal. Solo pide acción si nunca se calibró o pasó >30d.
  if (!p.teamVertical) {
    rows.push({
      id: "cerebro",
      name: "Cerebro",
      icon: Brain,
      status: "needs",
      headline: "Aún no me enseñaste tu negocio",
      why: "Te calibro ciclo y cliente ideal",
      href: p.settingsHref,
      cta: "Enseñarle",
    });
  } else if (p.needsRecheck) {
    rows.push({
      id: "cerebro",
      name: "Cerebro",
      icon: Brain,
      status: "needs",
      headline: `Calibrado ${p.learnedAgo ?? "hace tiempo"}, ¿cambió tu negocio?`,
      why: `Ciclo ~${p.teamCycle ?? "?"}d · conviene recalibrar`,
      href: p.settingsHref,
      cta: "Recalibrar",
    });
  } else {
    rows.push({
      id: "cerebro",
      name: "Cerebro",
      icon: Brain,
      status: "paused",
      headline: `Calibrado ${p.learnedAgo ?? "reciente"} · ciclo ~${p.teamCycle ?? "?"}d`,
      why: "En pausa: ya sabe tu ritmo, no necesita correr diario",
    });
  }

  // Scout
  if (p.hasMotor) {
    if (p.hoyActuar > 0) {
      rows.push({
        id: "scout",
        name: "Scout",
        icon: Radar,
        status: "active",
        headline: `Vigiló ${p.totalVigilados} · ${p.hoyActuar} listos para actuar`,
        why: `${p.hoyVigilar} en vigilancia, resto en automático${agoSuffix("scout")}`,
        href: p.reviewHref,
        cta: "Ver",
      });
    } else {
      rows.push({
        id: "scout",
        name: "Scout",
        icon: Radar,
        status: "paused",
        headline: `Vigiló ${p.totalVigilados}, nadie necesita mensaje`,
        why: `En pausa: no quemas clientes${agoSuffix("scout")}`,
      });
    }
  } else if (p.atRisk > 0) {
    rows.push({
      id: "scout",
      name: "Scout",
      icon: Radar,
      status: "active",
      headline: `${p.atRisk} por recuperar`,
      why: `Detecta quién debió volver${agoSuffix("scout")}`,
      href: p.reviewHref,
      cta: "Ver",
    });
  } else {
    // Sin motor y sin riesgo: distinguir pausa intencional de nunca-corrió.
    const everRan = p.runAgos.scout != null || p.pulseStates?.scout != null;
    rows.push({
      id: "scout",
      name: "Scout",
      icon: Radar,
      status: "paused",
      headline: everRan ? "Todo vigilado, nada vencido" : "Aún sin primera vigilancia",
      why: everRan
        ? "En pausa: sigue observando en automático"
        : "En pausa: corre Scout y empieza a vigilar",
    });
  }

  // Estratega
  if (p.topLeadName) {
    rows.push({
      id: "estratega",
      name: "Estratega",
      icon: ListChecks,
      status: "active",
      headline: `Ordenó, empieza por ${p.topLeadName}`,
      why: `Prioriza por valor y ventana${agoSuffix("strategist")}`,
    });
  } else if (p.pending > 0) {
    rows.push({
      id: "estratega",
      name: "Estratega",
      icon: ListChecks,
      status: "active",
      headline: "Todo accionable ya tiene borrador",
      why: `Listo en Review${agoSuffix("strategist")}`,
      href: p.reviewHref,
      cta: "Ver",
    });
  } else {
    const everRan = p.runAgos.strategist != null || p.pulseStates?.strategist != null;
    rows.push({
      id: "estratega",
      name: "Estratega",
      icon: ListChecks,
      status: "paused",
      headline: everRan ? "Sin ordenar, nada urgente" : "Aún sin priorizar",
      why: everRan
        ? "En pausa: no hay a quién priorizar hoy"
        : "En pausa: corre tras el Scout",
    });
  }

  // Redactor
  if (p.pending > 0) {
    rows.push({
      id: "redactor",
      name: "Redactor",
      icon: PenLine,
      status: "needs",
      headline: `Dejó ${p.pending} ${p.pending === 1 ? "listo" : "listos"} para tu visto bueno`,
      why: `Te ahorra redactar 1-a-1${agoSuffix("copywriter")}`,
      href: p.reviewHref,
      cta: "Revisar",
    });
  } else {
    rows.push({
      id: "redactor",
      name: "Redactor",
      icon: PenLine,
      status: "paused",
      headline: "Sin borradores",
      why: "En pausa: no había priorizados frescos, no inventa mensajes",
    });
  }

  // Prospector
  if (p.leadsPending > 0) {
    rows.push({
      id: "prospector",
      name: "Prospector",
      icon: UserPlus,
      status: "needs",
      headline: `${p.leadsPending} parecidos a tu ideal por revisar`,
      why: `Busca negocios nuevos${agoSuffix("prospect")}`,
      href: p.leadsHref,
      cta: "Ver",
    });
  } else {
    rows.push({
      id: "prospector",
      name: "Prospector",
      icon: UserPlus,
      status: "paused",
      headline: "En pausa",
      why: "Primero recuperamos lo tuyo antes de buscar nuevos",
    });
  }

  // Mensajero
  if (p.approved > 0) {
    rows.push({
      id: "mensajero",
      name: "Mensajero",
      icon: Send,
      status: "needs",
      headline: `${p.approved} ${p.approved === 1 ? "listo" : "listos"}, conecta canal para enviar`,
      why: "Bloqueado: no envío sin tu permiso ni sin WhatsApp/email",
      href: p.settingsHref,
      cta: "Conectar",
    });
  } else if (p.dispatched > 0) {
    rows.push({
      id: "mensajero",
      name: "Mensajero",
      icon: Send,
      status: "active",
      headline: `${p.dispatched} enviadas`,
      why: "Solo lo que aprobaste, nada sin permiso",
    });
  } else {
    rows.push({
      id: "mensajero",
      name: "Mensajero",
      icon: Send,
      status: "paused",
      headline: "En pausa, nada aprobado",
      why: "No envío sin tu permiso",
    });
  }

  // Analista
  if (p.converted > 0) {
    rows.push({
      id: "analista",
      name: "Analista",
      icon: TrendingUp,
      status: "active",
      headline: `${p.converted} ${p.converted === 1 ? "volvió" : "volvieron"} · ${p.recoveredLabel} recuperado`,
      why: `Mide retorno real${agoSuffix("analyst")}`,
    });
  } else if (p.dispatched > 0) {
    rows.push({
      id: "analista",
      name: "Analista",
      icon: TrendingUp,
      status: "paused",
      headline: `Observando ${p.dispatched} enviados`,
      why: "En pausa: mide si vuelven en días, aún sin retorno",
    });
  } else {
    rows.push({
      id: "analista",
      name: "Analista",
      icon: TrendingUp,
      status: "paused",
      headline: "Observando, nada que medir aún",
      why: "Mide solo cuando hay envíos",
    });
  }

  return rows.sort((a, b) => priority[a.status] - priority[b.status]);
}

export function TeamPulse(p: TeamPulseProps) {
  const rows = buildRows(p);
  const activeCount = rows.filter((r) => r.status !== "paused").length;
  const needsCount = rows.filter((r) => r.status === "needs").length;
  const alive = activeCount > 0;

  return (
    <CardContent className="flex flex-col gap-1 p-4">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className={`size-1.5 rounded-full ${alive ? "animate-pulse bg-emerald-500" : "bg-muted-foreground/40"}`}
          />
          Tu equipo IA · {activeCount} {activeCount === 1 ? "activo" : "activos"} hoy
        </span>
        {p.lastActionAgo && (
          <span className="font-normal normal-case tracking-normal">· última acción {p.lastActionAgo}</span>
        )}
      </span>
      <span className="text-xs text-muted-foreground">
        {needsCount > 0
          ? `${needsCount} ${needsCount === 1 ? "agente necesita tu decisión" : "agentes necesitan tu decisión"}, el resto trabaja solo.`
          : "Nadie te necesita ahora — todos vigilan solos."}
      </span>
      {p.runningLabels && p.runningLabels.length > 0 && (
        <p className="text-xs text-muted-foreground tabular-nums">
          En curso ahora: {p.runningLabels.join(" · ")}
        </p>
      )}
      <ul className="mt-1 divide-y divide-border/60">
        {rows.map((r) => {
          const Icon = r.icon;
          const dimmed = r.status === "paused";
          return (
            <li key={r.id} className="flex items-start gap-2.5 py-2">
              <span
                aria-hidden
                className={`mt-[7px] size-1.5 shrink-0 rounded-full ${dotCls[r.status]}${r.status !== "paused" ? " animate-pulse" : ""}`}
              />
              <Icon
                aria-hidden
                className={`mt-0.5 size-4 shrink-0 ${dimmed ? "text-muted-foreground/60" : "text-muted-foreground"}`}
              />
              <div className="flex min-w-0 flex-1 flex-col">
                <p className={`text-[13px] leading-snug ${dimmed ? "text-muted-foreground" : ""}`}>
                  <strong className={dimmed ? "font-medium text-muted-foreground" : ""}>{r.name}</strong>{" "}
                  {r.headline}
                  {r.href && r.cta && (
                    <ClickStop className="inline">
                      {" → "}
                      <Link href={r.href} className="font-medium text-foreground underline">
                        {r.cta}
                      </Link>
                    </ClickStop>
                  )}
                </p>
                <p className="text-xs leading-snug text-muted-foreground">{r.why}</p>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-1 border-t border-border/60 pt-2 text-xs text-muted-foreground">
        Las pausas ahorran mensajes y descuentos: no se escribe por escribir.
      </p>
    </CardContent>
  );
}
