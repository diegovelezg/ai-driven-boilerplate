// SSOT del picker de pantallas (nueva orden + editar pantallas del drawer).
// Misma forma en ambos: id, nombre, detalle (sede/distrito/ciudad/proveedor),
// código (external_ref, solo búsqueda) y precio de referencia.
export interface ScreenPick {
  id: string;
  name: string;
  detail: string | null;
  code: string | null;
  price_pen: number | null;
}

export function plural(n: number): string {
  return n === 1 ? "" : "s";
}
