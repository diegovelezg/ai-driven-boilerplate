import type { ReactNode } from "react";
import { cn } from "cn";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export type AppCardTone = "default" | "primary" | "emerald" | "amber" | "sky" | "violet" | "rose";
export type AppCardVariant = "default" | "hero" | "table";

const TONE_BORDER: Record<Exclude<AppCardTone, "default">, string> = {
  primary: "border-l-2 border-l-primary/40",
  emerald: "border-l-2 border-l-emerald-500/40",
  amber: "border-l-2 border-l-amber-500/40",
  sky: "border-l-2 border-l-sky-500/40",
  violet: "border-l-2 border-l-violet-500/40",
  rose: "border-l-2 border-l-rose-500/40",
};

/**
 * SSOT para Cards. Usa Header/Footer nativos del primitivo:
 * - title/description/action -> CardHeader/Title/Description/Action
 * - children -> CardContent SIN paddings manuales (hereda --card-spacing)
 * - footer -> CardFooter nativo (border-t bg-muted/50)
 * No usar p-4/p-5/p-0/px-5 ni divs border-t manuales fuera de aquí.
 */
export function AppCard({
  title,
  description,
  action,
  footer,
  tone = "default",
  variant = "default",
  size,
  className,
  headerClassName,
  contentClassName,
  footerClassName,
  /** Al proveerlo, TODO el header abre el drawer (inbox): cursor pointer
   *  + teclado (Enter/Espacio). Los interactivos internos (checkbox)
   *  hacen stopPropagation para no dispararlo. */
  onHeaderClick,
  children,
  ...rest
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  footer?: ReactNode;
  tone?: AppCardTone;
  variant?: AppCardVariant;
  size?: "default" | "sm";
  className?: string;
  headerClassName?: string;
  contentClassName?: string;
  footerClassName?: string;
  onHeaderClick?: () => void;
  children: ReactNode;
} & Omit<React.ComponentProps<"div">, "title" | "className">) {
  const hasHeader = title !== undefined || description !== undefined || action !== undefined;
  return (
    <Card
      size={size}
      {...rest}
      className={cn(
        tone !== "default" && TONE_BORDER[tone],
        variant === "hero" && "bg-gradient-to-br from-primary/[0.07] via-card to-card",
        variant === "table" && "gap-0 py-0",
        className,
      )}
    >
      {hasHeader && (
        <CardHeader
          className={cn(onHeaderClick && "cursor-pointer", headerClassName)}
          onClick={onHeaderClick ? () => onHeaderClick() : undefined}
          onKeyDown={
            onHeaderClick
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onHeaderClick();
                  }
                }
              : undefined
          }
          role={onHeaderClick ? "button" : undefined}
          tabIndex={onHeaderClick ? 0 : undefined}
          title={onHeaderClick ? "Abrir ficha del cliente" : undefined}
        >
          {title !== undefined && <CardTitle>{title}</CardTitle>}
          {description !== undefined && <CardDescription>{description}</CardDescription>}
          {action !== undefined && <CardAction>{action}</CardAction>}
        </CardHeader>
      )}
      <CardContent
        className={cn(
          // Table edge-to-edge: quita el px central solo aquí, centralizado.
          variant === "table" && "px-0",
          contentClassName,
        )}
      >
        {children}
      </CardContent>
      {footer !== undefined && <CardFooter className={footerClassName}>{footer}</CardFooter>}
    </Card>
  );
}

/** Estado simple (loading/vacío/error): Card con contenido centrado verticalmente. */
export function AppCardState({
  children,
  tone,
  size,
  className,
}: {
  children: ReactNode;
  tone?: AppCardTone;
  size?: "default" | "sm";
  className?: string;
}) {
  return (
    <AppCard tone={tone} size={size} className={className} contentClassName="text-sm text-muted-foreground">
      {children}
    </AppCard>
  );
}
