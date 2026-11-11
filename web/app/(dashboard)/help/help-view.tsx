"use client";

import Link from "next/link";
import { ArrowRight, Building2, Monitor, ReceiptText, Tags } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Separator } from "@/components/ui/separator";

const SHORTCUTS = [
  {
    href: "/orders",
    label: "Órdenes",
    hint: "Crea y sigue cada pauta, del borrador al cierre.",
    icon: ReceiptText,
  },
  {
    href: "/screens",
    label: "Inventario",
    hint: "Ubicaciones, pantallas y precios disponibles.",
    icon: Monitor,
  },
  {
    href: "/companies",
    label: "Empresas",
    hint: "Agencias, anunciantes y proveedores con sus contactos.",
    icon: Building2,
  },
  {
    href: "/brands",
    label: "Marcas",
    hint: "Qué marcas pautan y con qué frecuencia vuelven.",
    icon: Tags,
  },
];

export function HelpView() {
  return (
    <div className="page-shell max-w-4xl">
      <PageHeader
        eyebrow="Ayuda"
        title="Cómo usar la plataforma"
        description="El recorrido completo: registra tu inventario, da de alta empresas y contactos, y crea órdenes para cada pauta."
      />

      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold tracking-tight">Atajos</h2>
        <ul className="flex flex-col">
          {SHORTCUTS.map(({ href, label, hint, icon: Icon }, i) => (
            <li key={href}>
              {i > 0 && <Separator />}
              <Link
                href={href}
                className="flex items-center gap-3 py-3 transition-colors hover:text-primary"
              >
                <span
                  aria-hidden
                  className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
                >
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{label}</span>
                  <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">{hint}</span>
                </span>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <Separator />

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold tracking-tight">Flujo de una orden</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Se crea en borrador con sus pantallas y precios. Luego avanza por firma, materiales,
          salida al aire y cierre. El cobro se registra en paralelo y admite pagos parciales.
        </p>
      </section>
    </div>
  );
}
