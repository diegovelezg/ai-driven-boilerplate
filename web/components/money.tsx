import { formatMoneyParts } from "@/lib/format";
import { cn } from "cn";

/**
 * SSOT de render de moneda (GUI).
 *
 * El código ISO va sutil frente al monto: `0.62em` relativo al contexto
 * (escala en KPIs `text-2xl` y en tablas `text-sm`), con piso de 10 px para
 * códigos ISO —metadata redundante, no la cifra—; `font-normal` explícito
 * para que no herede el peso del contexto (`semibold` en totales y botones);
 * `text-muted-foreground` —token ya calibrado para claro y oscuro— en vez
 * de grises fijos u `opacity` (que rompería el contraste sobre filas
 * tintadas); `tracking` leve + uppercase para que siga legible en pequeño.
 * El monto hereda color y peso del padre (tonos de `Metric`,
 * `text-destructive` en vencidos…); `tabular-nums` solo en la cifra.
 * `whitespace-nowrap` + `items-baseline`: código y monto nunca se parten
 * de línea.
 *
 * Usar en toda UI visible. `formatMoney` (string) queda para contextos
 * solo-texto: aria-labels, tooltips en string, CSV, print y composiciones
 * multi-moneda ("PEN … + USD …").
 */
export function Money({
  amountMinor,
  currency,
  decimals = 0,
  className,
  currencyClassName,
}: {
  amountMinor: number | string | null | undefined;
  currency: string | null | undefined;
  decimals?: number;
  className?: string;
  currencyClassName?: string;
}) {
  const { code, body, text } = formatMoneyParts(amountMinor, currency, decimals);
  if (body === "—") return <span className={cn(className)}>—</span>;
  return (
    <span
      className={cn("inline-flex items-baseline gap-[0.35em] whitespace-nowrap", className)}
      title={text}
    >
      <span
        className={cn(
          "text-[max(0.62em,10px)] font-normal uppercase tracking-[0.02em] text-muted-foreground",
          currencyClassName,
        )}
      >
        {code}
      </span>
      <span className="tabular-nums">{body}</span>
    </span>
  );
}
