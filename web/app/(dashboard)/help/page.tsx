import { HelpView } from "./help-view";

export const instant = false;

// Centro de ayuda: estructura típica (nav por temas + búsqueda),
// contenido mínimo. Página estática, sin DB.
export default function AyudaPage() {
  return <HelpView />;
}
