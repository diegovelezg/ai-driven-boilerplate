"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Botón "Imprimir / Guardar PDF": dispara el diálogo del navegador
 *  (destino "Guardar como PDF"). Se oculta en el papel (`print:hidden`). */
export function PrintButton() {
  return (
    <Button size="sm" onClick={() => window.print()}>
      <Printer aria-hidden />
      Imprimir / Guardar PDF
    </Button>
  );
}
