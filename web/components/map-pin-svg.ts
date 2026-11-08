// SVG de `map-pin-check-inside` (Lucide, ISC, ya dependencia del proyecto)
// como string: los divIcon de Leaflet reciben HTML crudo, no componentes React.
// Color = `var(--primary)` (fucsia del tema, adapta a claro/oscuro);
// `fill #fff` en el cuerpo para legibilidad sobre cualquier tesela.
export function mapPinCheckInsideSvg(size = 30): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;color:var(--primary);filter:drop-shadow(0 1px 2px rgb(0 0 0 / 0.35))"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" fill="#ffffff"/><path d="m9 10 2 2 4-4"/></svg>`;
}
