import type { ReactNode, TableHTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "cn";

/**
 * Variante compacta del estilo de tabla del catálogo, para drawers.
 * Misma estructura (header con fondo, hover en filas, bordes) pero
 * `text-[13px]` y `py-2` en vez de `text-sm` / `py-3`. Headers sin caps.
 */
export function DrawerTable({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className={cn("w-full text-[13px]", className)}>{children}</table>
    </div>
  );
}

export function DrawerTableBody({ children, className }: { children: ReactNode; className?: string }) {
  return <tbody className={cn("tabular-nums", className)}>{children}</tbody>;
}

export function DrawerTableHeader({ children }: { children: ReactNode }) {
  return (
    <thead>
      <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
        {children}
      </tr>
    </thead>
  );
}

export function DrawerTableRow({
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

export function DrawerTableTh({
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
    <th className={cn("px-3 py-2 font-medium", numeric && "text-right", className)} {...rest}>
      {children}
    </th>
  );
}

export function DrawerTableTd({
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
    <td className={cn("px-3 py-2", numeric && "text-right", className)} {...rest}>
      {children}
    </td>
  );
}
