// Registro de conectores: `getConnector(platform)` es el único acceso
// que `lib/sync.ts` usa. Agregar Shopify/Woo = nuevo archivo
// `connectors/<platform>.ts` + 1 línea aquí, sin tocar el sync.
import { medusaConnector } from "@/lib/connectors/medusa";
import {
  ConnectorNotImplementedError,
  type ConnectorPlatform,
  type EcommerceConnector,
} from "@/lib/connectors/types";

export type { ConnectorPlatform, EcommerceConnector } from "@/lib/connectors/types";
export { ConnectorNotImplementedError } from "@/lib/connectors/types";
export { isRealDbOrder, isRealOrder } from "@/lib/canonical";

/** Plataformas con backend real hoy. `shopify`/`woocommerce` lanzan al usarse. */
export const SUPPORTED_CONNECTORS: readonly ConnectorPlatform[] = ["medusa"] as const;

export function getConnector(platform: ConnectorPlatform): EcommerceConnector {
  switch (platform) {
    case "medusa":
      return medusaConnector;
    case "shopify":
    case "woocommerce":
      throw new ConnectorNotImplementedError(platform);
    default:
      throw new ConnectorNotImplementedError(String(platform));
  }
}

/** true si la plataforma ya sincroniza (no solo guarda preset en settings). */
export function isConnectorSupported(platform: string): boolean {
  return (SUPPORTED_CONNECTORS as readonly string[]).includes(platform);
}
