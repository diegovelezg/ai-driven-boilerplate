"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  ArrowRight,
  BookOpen,
  Brain,
  CircleHelp,
  Compass,
  ListChecks,
  Rocket,
  Search,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import { cn } from "cn";
import { Input } from "@/components/ui/input";
import { AppCard } from "@/components/app-card";
import { formatNumber } from "@/lib/format";
import { DECISION_COPY } from "@/lib/decision-copy";

interface Article {
  id: string;
  title: string;
  text: string;
  bullets?: string[];
  href?: string;
  hrefLabel?: string;
}

interface Section {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  tone: ToneKey;
  articles: Article[];
}

interface ResultArticle extends Article {
  section: Section;
}

const TONES = {
  primary: {
    bar: "bg-primary",
    soft: "bg-primary/10",
    solid: "bg-primary text-primary-foreground",
    text: "text-primary",
    ring: "ring-primary/20",
    marker: "marker:text-primary",
  },
  violet: {
    bar: "bg-violet-500",
    soft: "bg-violet-500/10",
    solid: "bg-violet-500 text-white",
    text: "text-violet-600 dark:text-violet-400",
    ring: "ring-violet-500/20",
    marker: "marker:text-violet-500",
  },
  sky: {
    bar: "bg-sky-500",
    soft: "bg-sky-500/10",
    solid: "bg-sky-500 text-white",
    text: "text-sky-600 dark:text-sky-400",
    ring: "ring-sky-500/20",
    marker: "marker:text-sky-500",
  },
  emerald: {
    bar: "bg-emerald-500",
    soft: "bg-emerald-500/10",
    solid: "bg-emerald-500 text-white",
    text: "text-emerald-600 dark:text-emerald-400",
    ring: "ring-emerald-500/20",
    marker: "marker:text-emerald-500",
  },
  amber: {
    bar: "bg-amber-500",
    soft: "bg-amber-500/10",
    solid: "bg-amber-500 text-amber-950",
    text: "text-amber-600 dark:text-amber-400",
    ring: "ring-amber-500/20",
    marker: "marker:text-amber-500",
  },
  cyan: {
    bar: "bg-cyan-500",
    soft: "bg-cyan-500/10",
    solid: "bg-cyan-500 text-white",
    text: "text-cyan-600 dark:text-cyan-400",
    ring: "ring-cyan-500/20",
    marker: "marker:text-cyan-500",
  },
  rose: {
    bar: "bg-rose-500",
    soft: "bg-rose-500/10",
    solid: "bg-rose-500 text-white",
    text: "text-rose-600 dark:text-rose-400",
    ring: "ring-rose-500/20",
    marker: "marker:text-rose-500",
  },
  orange: {
    bar: "bg-orange-500",
    soft: "bg-orange-500/10",
    solid: "bg-orange-500 text-orange-950",
    text: "text-orange-600 dark:text-orange-400",
    ring: "ring-orange-500/20",
    marker: "marker:text-orange-500",
  },
} as const;

type ToneKey = keyof typeof TONES;

const LOOP: Array<{ label: string; tone: ToneKey }> = [
  { label: "Detectar", tone: "sky" },
  { label: "Decidir", tone: "violet" },
  { label: "Proponer", tone: "amber" },
  { label: "Aprobar", tone: "emerald" },
  { label: "Ejecutar", tone: "rose" },
  { label: "Medir", tone: "cyan" },
];

const SECTIONS: Section[] = [
  {
    id: "empezar",
    label: "Primeros pasos",
    description: "De conectar a aprobar en 3 movimientos.",
    icon: Rocket,
    tone: "primary",
    articles: [
      {
        id: "paso-conectar",
        title: "1 · Enséñale tu negocio",
        text: "En Negocio describes qué vendes y cada cuánto vuelven: con eso fija ciclo, patrón y ventana. La app lee su propia base.",
        href: "/settings?tab=negocio",
        hrefLabel: "Describir negocio",
      },
      {
        id: "paso-revisar",
        title: "2 · Revisa el día",
        text: "El Dashboard abre con Hoy: cuántos necesitan mensaje, cuánto hay en juego y el #1 por dónde empezar. Los borradores esperan en Review: apruebas, editas o rechazas.",
        href: "/review",
        hrefLabel: "Ir a Review",
      },
      {
        id: "paso-cerrar",
        title: "3 · Cierra el loop",
        text: "El email aprobado sale solo si conectaste SendGrid; si no, queda en cola. WhatsApp es manual: abres el wa.me prellenado, envías desde tu número y marcas enviado para que se pueda medir.",
      },
    ],
  },
  {
    id: "logica",
    label: "Cómo piensa",
    description: "Estima con tus datos; cuando duda, vigila.",
    icon: Brain,
    tone: "violet",
    articles: [
      {
        id: "estima",
        title: "Estima tu ritmo, no aplica reglas fijas",
        text: "Con 2+ compras aprende el ritmo del cliente; con 1 usa la cohorte de la tienda. Cada caso trae probabilidad y confianza. Con eso elige actuar, vigilar o no tocar: si hay pocos datos o la ventana es amplia, prefiere vigilar antes que molestar.",
        bullets: [
          "Ventana: si está antes, dentro o pasado su rango habitual de retorno (p25–p75).",
          "Probabilidad y valor: chance de que vuelva solo × ticket esperado.",
          "Elegibilidad: canal usable y sin contacto reciente.",
        ],
      },
      {
        id: "no-tocar",
        title: "También decide a quién NO escribir",
        text: "Ni a quien volverá solo, ni dormidos, ni sin canal, ni contactados hace poco. No quemar el canal ni regalar descuento es parte del producto.",
      },
      {
        id: "atribucion",
        title: "Mide atribución, no promete milagros",
        text: "Si el cliente compra en la ventana tras el mensaje, se marca como recuperado atribuido. Sin grupo de control no hay causalidad, y con pocos datos las estimaciones son débiles: la app lo dice en vez de esconderlo.",
      },
    ],
  },
  {
    id: "equipo",
    label: "Tu equipo IA",
    description: "Seis pasos; tú cierras el ciclo.",
    icon: Users,
    tone: "sky",
    articles: [
      {
        id: "loop",
        title: "El loop en 6 pasos",
        text: "Cada agente hace una cosa y ninguno envía por su cuenta.",
        bullets: [
          "Detectar — Scout marca quién necesita acción.",
          "Decidir — Estratega ordena por valor en juego; el #1 va primero.",
          "Proponer — Redactor escribe WhatsApp (≤450) o email usando historial real, sin cifras inventadas.",
          "Aprobar — Tú, en Review: editas, cambias de canal, apruebas o rechazas.",
          "Ejecutar — Mensajero envía el email; WhatsApp sale a mano por wa.me.",
          "Medir — Analista registra si el cliente volvió en la ventana.",
        ],
      },
      {
        id: "secundarios",
        title: "Cerebro y Prospector (secundarios)",
        text: "Cerebro resume tu negocio y se actualiza si pasó más de un día; si pasan 30 días o cambias el negocio, pide recalibrar. Prospector busca empresas parecidas a tus mejores clientes, como apoyo: primero se recupera lo propio, nunca contacta solo.",
        href: "/review?tab=leads",
        hrefLabel: "Ver empresas por contactar",
      },
      {
        id: "chat",
        title: "El chat",
        text: "Responde cifras, arma listas y lanza corridas. Las listas aparecen al costado; nada se aprueba ni envía sin tu confirmación.",
      },
    ],
  },
  {
    id: "tu-parte",
    label: "Lo que se espera de ti",
    description: "Tres hábitos sostienen el loop.",
    icon: ListChecks,
    tone: "emerald",
    articles: [
      {
        id: "datos",
        title: "Datos que permitan escribir",
        text: "Teléfonos y emails completos, duplicados resueltos. Sin canal no hay mensaje; con fichas partidas la predicción empeora. Si el motor se equivoca, corrige datos o recalibra antes de forzar.",
        href: "/customers",
        hrefLabel: "Revisar Customers",
      },
      {
        id: "aprobar",
        title: "Aprueba y envía el WhatsApp",
        text: "Lee el porqué de cada borrador, ajusta el tono y decide empresa por empresa. WhatsApp sale de tu número por wa.me: envíalo y marca enviado, o el loop queda abierto.",
        href: "/review",
        hrefLabel: "Ir a Review",
      },
      {
        id: "resultado",
        title: "Mira si volvieron y recalibra",
        text: "Revisa últimos enviados y Finanzas en la ventana de tu negocio. Más historial, mejores estimaciones; si cambias precios, catálogo o temporada, recalibra.",
        href: "/finanzas",
        hrefLabel: "Ir a Finanzas",
      },
    ],
  },
  {
    id: "secciones",
    label: "Mapa de la app",
    description: "Dónde vive cada cosa.",
    icon: Compass,
    tone: "amber",
    articles: [
      {
        id: "s-dashboard",
        title: "Dashboard",
        text: "Hoy, embudo, últimos enviados y salud de tu equipo IA. Para decidir qué hacer ahora.",
        href: "/",
        hrefLabel: "Abrir Dashboard",
      },
      {
        id: "s-review",
        title: "Review Inbox",
        text: "Por contactar, en riesgo y empresas (Prospector). Todo lo que espera tu visto bueno.",
        href: "/review",
        hrefLabel: "Abrir Review",
      },
      {
        id: "s-customers",
        title: "Customers",
        text: "Ficha por cliente: compras, contactos y agente. Filtra por decisión, ritmo o ventana.",
        href: "/customers",
        hrefLabel: "Abrir Customers",
      },
      {
        id: "s-finanzas",
        title: "Finanzas",
        text: "Ventas y recuperado atribuido separado de lo que está en juego. Sin mezclar monedas.",
        href: "/finanzas",
        hrefLabel: "Abrir Finanzas",
      },
      {
        id: "s-settings",
        title: "Settings",
        text: "Tienda, email, negocio y motor. Si algo no cuadra, empieza aquí.",
        href: "/settings",
        hrefLabel: "Abrir Settings",
      },
    ],
  },
  {
    id: "glosario",
    label: "Glosario",
    description: "El vocabulario que vas a ver en pantalla.",
    icon: BookOpen,
    tone: "cyan",
    articles: [
      {
        id: "g-actuar",
        title: DECISION_COPY.paraActuarHoy.label,
        text: DECISION_COPY.paraActuarHoy.tip,
      },
      {
        id: "g-vigilar-pronto",
        title: DECISION_COPY.puedenNecesitar.label,
        text: DECISION_COPY.puedenNecesitar.tip,
      },
      {
        id: "g-vigilar-sin-accion",
        title: DECISION_COPY.vigiladosSinAccion.label,
        text: DECISION_COPY.vigiladosSinAccion.tip,
      },
      {
        id: "g-notocar",
        title: DECISION_COPY.sinNadaQueHacer.label,
        text: DECISION_COPY.sinNadaQueHacer.tip,
      },
      {
        id: "g-ritmo",
        title: "Ritmo y ventana (p25–p75)",
        text: "Con ritmo = 2+ compras con intervalo propio. Primera recompra = 1 compra, se estima con la cohorte. Ventana = rango de días donde suele volver; pasado ese rango, empieza a estar vencido.",
      },
      {
        id: "g-valor",
        title: "Valor en juego",
        text: "Ticket esperado × probabilidad de recompra. Para priorizar, no una promesa de ingreso.",
      },
      {
        id: "g-recuperado",
        title: "Recuperado atribuido",
        text: "Ingreso de clientes que volvieron en la ventana tras el mensaje. Atribuido, no incremental.",
      },
    ],
  },
  {
    id: "faq",
    label: "Preguntas frecuentes",
    description: "Lo que queda tras leer lo anterior.",
    icon: CircleHelp,
    tone: "rose",
    articles: [
      {
        id: "f-pocos",
        title: "¿Por qué hay tan pocos mensajes?",
        text: "Porque también decide a quién no escribir. Prefiere vigilar antes que contactar fuera de ventana o sin datos.",
      },
      {
        id: "f-actualiza",
        title: "¿Cuándo se actualiza?",
        text: "El motor corre por corridas (Scout → Estratega → Redactor). No es tiempo real: la app muestra la fecha de la última foto.",
      },
      {
        id: "f-crm",
        title: "¿Reemplaza mi CRM?",
        text: "No. No gestiona stock, precios ni ventas: decide a quién contactar, propone el mensaje y mide el retorno.",
      },
      {
        id: "f-plataformas",
        title: "¿Con qué tiendas funciona y de dónde salen los datos?",
        text: "Los datos salen de tu propia base (inventario DOOH vía Sheet/CSV). Cada tienda es un tenant aislado.",
      },
      {
        id: "f-editar",
        title: "¿Puedo editar el mensaje?",
        text: "Sí, mientras está pendiente. Aprobado o enviado ya no; cada edición queda auditada.",
      },
    ],
  },
];

/** Scrollspy: resalta la sección que está cruzando la parte alta del viewport.
 *  Un clic en la nav fija la sección elegida hasta que el usuario vuelva a
 *  scrollear a mano (así el bottom del documento no le roba el highlight). */
function useScrollSpy(enabled: boolean) {
  const [active, setActive] = useState(SECTIONS[0].id);
  const pinned = useRef<string | null>(null);

  useEffect(() => {
    const clear = () => {
      pinned.current = null;
    };
    window.addEventListener("wheel", clear, { passive: true });
    window.addEventListener("touchmove", clear, { passive: true });
    window.addEventListener("keydown", clear);
    window.addEventListener("mousedown", clear);
    return () => {
      window.removeEventListener("wheel", clear);
      window.removeEventListener("touchmove", clear);
      window.removeEventListener("keydown", clear);
      window.removeEventListener("mousedown", clear);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const ids = SECTIONS.map((s) => s.id);
    let frame = 0;

    const update = () => {
      frame = 0;
      if (pinned.current) return;
      const threshold = 120;
      let current = ids[0];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= threshold) current = id;
      }
      // Al llegar al fondo, la última sección gana aunque su título no cruce el umbral.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 8) {
        current = ids[ids.length - 1] ?? current;
      }
      setActive((prev) => (prev === current ? prev : current));
    };

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [enabled]);

  const pin = (id: string) => {
    pinned.current = id;
    setActive(id);
  };

  return [active, pin] as const;
}

function ArticleCard({
  article,
  section,
  showSection = false,
}: {
  article: Article;
  section: Section;
  showSection?: boolean;
}) {
  const tone = TONES[section.tone];
  const Icon = section.icon;

  return (
    <AppCard
      title={article.title}
      action={
        showSection ? (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
              tone.soft,
              tone.text,
            )}
          >
            <Icon className="size-3" aria-hidden />
            {section.label}
          </span>
        ) : undefined
      }
      className="group transition-shadow hover:shadow-sm"
    >
      <div className="flex gap-3">
        <span
          aria-hidden
          className={cn("mt-1.5 h-5 w-0.5 shrink-0 rounded-full", tone.bar)}
        />
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] leading-relaxed text-foreground/80">
            {article.text}
          </p>
          {article.bullets && article.bullets.length > 0 && (
            <ul
              className={cn(
                "mt-2.5 list-disc space-y-1.5 pl-5 text-[13.5px] leading-relaxed text-foreground/80",
                tone.marker,
              )}
            >
              {article.bullets.map((bullet) => (
                <li key={bullet}>{bullet}</li>
              ))}
            </ul>
          )}
          {article.href && (
            <Link
              href={article.href}
              className={cn(
                "mt-3 inline-flex items-center gap-1 text-[13px] font-medium hover:underline",
                tone.text,
              )}
            >
              {article.hrefLabel ?? "Abrir"}
              <ArrowRight
                className="size-3.5 transition-transform group-hover:translate-x-0.5"
                aria-hidden
              />
            </Link>
          )}
        </div>
      </div>
    </AppCard>
  );
}

export function AyudaView() {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();

  const results = useMemo<ResultArticle[] | null>(() => {
    if (!query) return null;
    return SECTIONS.flatMap((s) =>
      s.articles
        .filter(
          (a) =>
            s.label.toLowerCase().includes(query) ||
            s.description.toLowerCase().includes(query) ||
            a.title.toLowerCase().includes(query) ||
            a.text.toLowerCase().includes(query) ||
            (a.bullets ?? []).some((b) => b.toLowerCase().includes(query)),
        )
        .map((a) => ({ ...a, section: s })),
    );
  }, [query]);

  const [activeSection, pinSection] = useScrollSpy(results === null);

  const goToSection = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    event.preventDefault();
    const el = document.getElementById(id);
    if (!el) return;
    pinSection(id);
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    const url = new URL(window.location.href);
    url.hash = id;
    window.history.replaceState(null, "", url);
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-6 md:p-8">
      <header className="flex flex-col gap-3">
        <span className="inline-flex w-fit items-center gap-1.5 text-[11px] font-semibold tracking-[0.16em] text-primary uppercase">
          <Sparkles className="size-3.5" aria-hidden />
          Centro de ayuda
        </span>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Ayuda</h1>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            Guía rápida
          </span>
        </div>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Qué hace, cómo piensa y qué te toca hacer. Lo esencial en 2 minutos.
        </p>
        <div className="relative mt-1 max-w-md">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar (ej. aprobar, actuar, finanzas)…"
            aria-label="Buscar en ayuda"
            className="h-10 rounded-lg pl-9"
          />
        </div>
      </header>

      {results === null && (
        <section
          aria-label="Qué es MEOW"
          className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-primary/[0.09] via-card to-card p-6 ring-1 ring-primary/15 md:p-7"
        >
          <div
            aria-hidden
            className="pointer-events-none absolute -top-24 -right-20 size-56 rounded-full bg-primary/10 blur-3xl"
          />
          <div className="relative flex flex-col gap-3">
            <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-primary px-2.5 py-1 text-[11px] font-semibold tracking-wide text-primary-foreground uppercase">
              <Sparkles className="size-3" aria-hidden />
              En 1 minuto
            </span>
            <h2 className="max-w-2xl text-xl font-semibold tracking-tight md:text-2xl">
              No es un CRM. Es tu motor de retención.
            </h2>
            <p className="max-w-2xl text-sm leading-relaxed text-foreground/80">
              Lee los datos de tu tienda, detecta quién ya debería haber vuelto,
              decide a quién escribirle primero, redacta el mensaje y mide si volvió.
            </p>
            <p className="max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
              <strong className="font-medium text-foreground">Tú apruebas:</strong>{" "}
              nada sale sin tu visto bueno. Primero se recupera a los clientes que
              ya tienes; buscar nuevos es secundario.
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-2">
              {LOOP.map((step, i) => {
                const tone = TONES[step.tone];
                return (
                  <span key={step.label} className="flex items-center gap-2">
                    {i > 0 && (
                      <span aria-hidden className="text-xs text-muted-foreground/50">
                        →
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-background/80 px-2.5 py-1 text-[11px] font-medium shadow-sm ring-1 ring-border/70">
                      <span
                        className={cn(
                          "flex size-4 items-center justify-center rounded-full text-[9px] font-bold",
                          tone.solid,
                        )}
                      >
                        {i + 1}
                      </span>
                      {step.label}
                    </span>
                  </span>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {results !== null ? (
        <section aria-label="Resultados" className="flex max-w-3xl flex-col gap-5">
          <p className="text-xs text-muted-foreground tabular-nums">
            {formatNumber(results.length)} resultado{results.length === 1 ? "" : "s"} para{" "}
            <span className="font-medium text-foreground">“{q.trim()}”</span>
          </p>
          {results.length === 0 ? (
            <article className="rounded-xl bg-card px-5 py-10 text-center ring-1 ring-foreground/10">
              <Search className="mx-auto mb-2 size-5 text-muted-foreground/50" aria-hidden />
              <p className="text-sm font-medium">Sin coincidencias</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Prueba con “aprobar”, “actuar” o “finanzas”.
              </p>
            </article>
          ) : (
            <div className="flex flex-col gap-4">
              {results.map((a) => (
                <ArticleCard
                  key={a.id}
                  article={a}
                  section={a.section}
                  showSection
                />
              ))}
            </div>
          )}
        </section>
      ) : (
        <div className="grid grid-cols-1 gap-8 md:grid-cols-[210px_minmax(0,1fr)] md:gap-10">
          <aside aria-label="Temas">
            <nav className="flex flex-row gap-1 overflow-x-auto pb-1 md:sticky md:top-16 md:flex-col md:overflow-visible md:pb-0">
              {SECTIONS.map((s) => {
                const active = activeSection === s.id;
                const tone = TONES[s.tone];
                const Icon = s.icon;
                return (
                  <a
                    key={s.id}
                    href={`#${s.id}`}
                    onClick={(e) => goToSection(e, s.id)}
                    aria-current={active ? "location" : undefined}
                    className={cn(
                      "group relative flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] transition-colors",
                      active
                        ? "bg-card font-medium text-foreground shadow-sm ring-1 ring-border/70"
                        : "text-muted-foreground hover:bg-card/70 hover:text-foreground",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "absolute inset-y-2 left-0 w-0.5 rounded-full transition-opacity",
                        tone.bar,
                        active ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <Icon
                      className={cn(
                        "size-4 shrink-0",
                        active
                          ? tone.text
                          : "text-muted-foreground/60 group-hover:text-muted-foreground",
                      )}
                      aria-hidden
                    />
                    <span className="whitespace-nowrap">{s.label}</span>
                  </a>
                );
              })}
            </nav>
          </aside>

          <div className="flex flex-col gap-12">
            {SECTIONS.map((s, index) => {
              const tone = TONES[s.tone];
              const Icon = s.icon;
              return (
                <section
                  key={s.id}
                  id={s.id}
                  aria-label={s.label}
                  className="scroll-mt-20"
                >
                  <div className="mb-4 flex items-start gap-3">
                    <span
                      className={cn(
                        "flex size-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset",
                        tone.soft,
                        tone.ring,
                        tone.text,
                      )}
                    >
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <h2 className="text-base font-semibold tracking-tight">
                          {s.label}
                        </h2>
                        <span className="text-[11px] text-muted-foreground/60 tabular-nums">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        {s.description}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col gap-4 md:gap-5">
                    {s.articles.map((a) => (
                      <ArticleCard key={a.id} article={a} section={s} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
