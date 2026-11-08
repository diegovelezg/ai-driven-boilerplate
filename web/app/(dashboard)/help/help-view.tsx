"use client";

import Link from "next/link";

export function HelpView() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-6 md:p-8">
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Ayuda</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Gestión comercial DOOH: empresas, inventario, órdenes e IOs.
          Fase 2: sin motor de retención ni pipeline programado.
        </p>
      </header>
      <div className="flex flex-col gap-4">
        <section className="flex flex-col gap-2">
          <h2 className="text-base font-semibold">Flujo comercial</h2>
          <p className="text-sm text-muted-foreground">
            Empresas → Inventario (venues/pantallas/slots) → Órdenes (IOs: contrato,
            hard hold, autorización OM/OC, materiales QC, emisión, certificación PoP,
            cobranza).
          </p>
          <p className="text-sm">
            <Link href="/orders" className="underline">Abrir Órdenes</Link>
            {" · "}
            <Link href="/screens" className="underline">Abrir Inventario</Link>
            {" · "}
            <Link href="/companies" className="underline">Abrir Empresas</Link>
            {" · "}
            <Link href="/brands" className="underline">Abrir Marcas</Link>
          </p>
        </section>
      </div>
    </div>
  );
}
