import type { ReactNode, TableHTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "cn";

/**
 * SSOT del estilo principal de tabla (referencia: catálogo).
 * Estructura: header con fondo, sin caps, hover en filas, bordes.
 * `text-sm` y `px-3 py-3`. Para drawers usar `drawer-table` (compacta).
 */
export function DataTable({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className={cn("w-full text-sm", className)}>{children}</table>
    </div>
  );
}

export function DataTableBody({ children, className }: { children: ReactNode; className?: string }) {
  return <tbody className={className}>{children}</tbody>;
}

export function DataTableHeader({ children }: { children: ReactNode }) {
  return (
    <thead>
      <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
        {children}
      </tr>
    </thead>
  );
}

export function DataTableRow({
  children,
  className,
  ...rest
}: {
  children: ReactNode;
  className?: string;
} & TableHTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={cn("border-b last:border-0 hover:bg-muted/30", className)} {...rest}>
      {children}
    </tr>
  );
}

export function DataTableTh({
  children,
  numeric,
  className,
  ...rest
}: {
  children?: ReactNode;
  numeric?: boolean;
  className?: string;
} & ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th className={cn("px-3 py-3 font-medium", numeric && "text-right", className)} {...rest}>
      {children}
    </th>
  );
}

export function DataTableTd({
  children,
  numeric,
  className,
  ...rest
}: {
  children?: ReactNode;
  numeric?: boolean;
  className?: string;
} & TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn("px-3 py-3", numeric && "text-right", className)} {...rest}>
      {children}
    </td>
  );
}

export type SortDir = "asc" | "desc";

/** Botón de header ordenable (misma pieza en catálogo y drawers). */
export function SortHeaderButton({
  active,
  dir,
  alignRight,
  onClick,
  ariaLabel,
  children,
}: {
  active: boolean;
  dir: SortDir;
  alignRight?: boolean;
  onClick: () => void;
  ariaLabel: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className={`inline-flex items-center gap-1 rounded px-1 py-1 hover:text-foreground ${
        alignRight ? "flex-row-reverse" : ""
      } ${active ? "text-foreground" : ""}`}
    >
      {children}{" "}
      {active ? (
        dir === "asc" ? (
          <ArrowUp className="size-3.5" aria-hidden />
        ) : (
          <ArrowDown className="size-3.5" aria-hidden />
        )
      ) : (
        <ChevronsUpDown className="size-3.5 opacity-40" aria-hidden />
      )}
    </button>
  );
}
