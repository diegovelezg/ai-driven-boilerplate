"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface Article {
  id: string;
  title: string;
  text: string;
  href?: string;
  hrefLabel?: string;
}

interface Section {
  id: string;
  label: string;
  articles: Article[];
}

const SECTIONS: Section[] = [
  {
    id: "empezar",
    label: "Primeros pasos",
    articles: [
      {
        id: "que-es",
        title: "Qué es AI Retention Engine",
        text: "No es un CRM. Es un motor de decisión y acción sobre tus datos: detecta quién debería haber vuelto, propone la siguiente mejor acción y mide si volvió.",
      },
      {
        id: "aprobacion",
        title: "Nada se envía sin tu aprobación",
        text: "El agente redacta, tú apruebas en Review. Sin visto bueno no hay envío.",
        href: "/review",
        hrefLabel: "Ir a Review",
      },
    ],
  },
  {
    id: "loop",
    label: "El loop",
    articles: [
      {
        id: "loop-6",
        title: "Detectar → Decidir → Proponer → Aprobar → Ejecutar → Medir",
        text: "Detecta quién se enfría, decide a quién contactar primero, redacta el mensaje, tú lo apruebas, se envía por WhatsApp/email y se mide si volvió a comprar.",
      },
    ],
  },
  {
    id: "secciones",
    label: "Secciones",
    articles: [
      {
        id: "s-dashboard",
        title: "Dashboard",
        text: "Hoy: para actuar, en vigilancia, en automático. Empieza por el #1.",
        href: "/",
        hrefLabel: "Ir al Dashboard",
      },
      {
        id: "s-review",
        title: "Review Inbox",
        text: "Borradores por aprobar o rechazar.",
        href: "/review",
        hrefLabel: "Ir a Review",
      },
      {
        id: "s-customers",
        title: "Customers",
        text: "Ficha por cliente: ritmo, ventana y valor en juego.",
        href: "/customers",
        hrefLabel: "Ir a Customers",
      },
      {
        id: "s-finanzas",
        title: "Finanzas",
        text: "Recuperado atribuido vs. en juego, sin mezclar monedas.",
        href: "/finanzas",
        hrefLabel: "Ir a Finanzas",
      },
      {
        id: "s-settings",
        title: "Settings",
        text: "Conexión de tienda y perfil del negocio (ciclo, arquetipo).",
        href: "/settings",
        hrefLabel: "Ir a Settings",
      },
    ],
  },
  {
    id: "glosario",
    label: "Glosario",
    articles: [
      {
        id: "g-actuar",
        title: "Actuar",
        text: "Conviene escribirle ahora.",
      },
      {
        id: "g-vigilar",
        title: "Vigilar",
        text: "Aún no; entra en ventana pronto.",
      },
      {
        id: "g-auto",
        title: "Automático",
        text: "Volverá solo, dormido o sin canal: no se toca.",
      },
      {
        id: "g-valor",
        title: "Valor en juego",
        text: "Ticket esperado × probabilidad de recompra.",
      },
    ],
  },
  {
    id: "faq",
    label: "Preguntas frecuentes",
    articles: [
      {
        id: "f-envio",
        title: "¿Se envía algo solo?",
        text: "No. Todo mensaje pasa por tu aprobación en Review.",
      },
      {
        id: "f-no-toca",
        title: "¿Por qué no se contacta a todos?",
        text: "El motor también decide a quién NO escribir para no quemar el canal.",
      },
    ],
  },
];

export function AyudaView() {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();

  const results = useMemo(() => {
    if (!query) return null;
    return SECTIONS.flatMap((s) =>
      s.articles
        .filter(
          (a) =>
            a.title.toLowerCase().includes(query) ||
            a.text.toLowerCase().includes(query),
        )
        .map((a) => ({ ...a, section: s.label })),
    );
  }, [query]);

  return (
    <div className="flex w-full flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold tracking-tight">Ayuda</h1>
        <p className="text-xs text-muted-foreground">
          Lo esencial en 2 minutos. Busca o navega por tema.
        </p>
        <div className="relative max-w-md">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar (ej. aprobar, actuar, finanzas)…"
            aria-label="Buscar en ayuda"
            className="pl-8"
          />
        </div>
      </header>

      {results !== null ? (
        <section aria-label="Resultados">
          <p className="mb-2 text-xs text-muted-foreground tabular-nums">
            {results.length} resultado{results.length === 1 ? "" : "s"} para “{q.trim()}”
          </p>
          {results.length === 0 ? (
            <Card>
              <CardContent className="p-4 text-[13px] text-muted-foreground">
                Sin coincidencias. Prueba con “aprobar”, “actuar” o “finanzas”.
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-col gap-3">
              {results.map((a) => (
                <Card key={a.id}>
                  <CardHeader>
                    <CardTitle className="text-sm font-medium">
                      {a.title}{" "}
                      <span className="font-normal text-muted-foreground">· {a.section}</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-1 text-[13px]">
                    <p>{a.text}</p>
                    {a.href && (
                      <Link href={a.href} className="w-fit underline">
                        {a.hrefLabel ?? "Abrir"}
                      </Link>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-[200px_1fr]">
          <aside aria-label="Temas">
            <nav className="flex flex-row gap-1 overflow-x-auto md:sticky md:top-14 md:flex-col">
              {SECTIONS.map((s) => (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  className="rounded-md px-2.5 py-1.5 text-[13px] whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {s.label}
                </a>
              ))}
            </nav>
          </aside>
          <div className="flex flex-col gap-8">
            {SECTIONS.map((s) => (
              <section key={s.id} id={s.id} aria-label={s.label} className="scroll-mt-16">
                <h2 className="mb-2 text-sm font-medium">{s.label}</h2>
                <div className="flex flex-col gap-3">
                  {s.articles.map((a) => (
                    <Card key={a.id}>
                      <CardHeader>
                        <CardTitle className="text-sm font-medium">{a.title}</CardTitle>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-1 text-[13px]">
                        <p>{a.text}</p>
                        {a.href && (
                          <Link href={a.href} className="w-fit underline">
                            {a.hrefLabel ?? "Abrir"}
                          </Link>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
