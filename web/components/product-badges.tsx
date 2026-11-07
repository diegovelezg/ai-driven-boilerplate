import { Badge } from "@/components/ui/badge";

/**
 * SSOT de insignias de productos. Activo verde (a la venta),
 * inactivo gris (pausado / fuera de catálogo).
 */
export function ProductStatusBadge({ isActive }: { isActive: boolean }) {
  return (
    <Badge
      variant={isActive ? "success" : "secondary"}
      className="font-normal"
      title={isActive ? "Producto activo" : "Producto inactivo"}
    >
      {isActive ? "activo" : "inactivo"}
    </Badge>
  );
}
