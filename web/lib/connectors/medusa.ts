// Conector Medusa v1/v2: primera implementación de `EcommerceConnector`.
// Adapta las funciones sueltas de `lib/medusa.ts` a la interfaz centralizada.
// Sin estado: delegación pura para no cambiar comportamiento del sync.
// Único módulo (además de la UI legacy) autorizado a importar `lib/medusa`
// directo: el resto del código programa contra `@/lib/connectors`.
import {
  listMedusaCustomers,
  listMedusaOrdersRaw,
  listMedusaProductsRaw,
  listMedusaRegions,
  medusaLogin,
  medusaOrderToCanonical,
  medusaProductToCanonical,
  testMedusa,
} from "@/lib/medusa";
import {
  marketsToRegions,
  regionsToMarkets,
  toCredentials,
  type CanonicalMarket,
  type ConnectorAuthInput,
  type ConnectorListOpts,
  type ConnectorTestResult,
  type EcommerceConnector,
  type RegionMap,
  type TokenLike,
} from "@/lib/connectors/types";

function tokenOf(creds: TokenLike): string {
  return toCredentials(creds).token;
}

export const medusaConnector: EcommerceConnector = {
  platform: "medusa",
  marketSource: "medusa_region",
  channelSource: "medusa_sales_channel",
  productSource: "medusa_product",

  authenticate(shopUrl: string, input: ConnectorAuthInput): Promise<string> {
    return medusaLogin(shopUrl, input.version === "v2" ? "v2" : "v1", input.email, input.password);
  },

  testConnection(
    shopUrl: string,
    creds: TokenLike,
    version = "v1",
  ): Promise<ConnectorTestResult> {
    return testMedusa(shopUrl, version === "v2" ? "v2" : "v1", tokenOf(creds));
  },

  async listMarkets(shopUrl: string, creds: TokenLike): Promise<CanonicalMarket[]> {
    return regionsToMarkets(await listMedusaRegions(shopUrl, tokenOf(creds)));
  },

  listRegions(shopUrl: string, creds: TokenLike): Promise<RegionMap> {
    return listMedusaRegions(shopUrl, tokenOf(creds));
  },

  listCustomers(shopUrl, creds, opts: ConnectorListOpts, version = "v1") {
    // `version` posicional (legacy) cede ante `opts.version` (ConnectorOpts).
    // Nota: `listMedusaCustomers` hoy ignora la versión (endpoint único v1);
    // se normaliza aquí para que el día que el bajo nivel bifurque, el sync
    // ya plomba v2 sin cambiar firmas.
    const v = opts.version ?? version;
    return listMedusaCustomers(shopUrl, v === "v2" ? "v2" : "v1", tokenOf(creds), {
      q: opts.q,
      offset: opts.offset,
      limit: opts.limit,
    });
  },

  listOrdersRaw(shopUrl, creds, opts: ConnectorListOpts) {
    return listMedusaOrdersRaw(shopUrl, tokenOf(creds), {
      email: opts.email,
      offset: opts.offset,
      limit: opts.limit,
    });
  },

  listProductsRaw(shopUrl, creds, opts: ConnectorListOpts) {
    return listMedusaProductsRaw(shopUrl, tokenOf(creds), {
      offset: opts.offset,
      limit: opts.limit,
    });
  },

  orderToCanonical(raw, regions) {
    return medusaOrderToCanonical(raw, regions);
  },

  productToCanonical(raw) {
    return medusaProductToCanonical(raw);
  },
};

/** Compat: mercados Medusa en forma legacy (el caché de sync lo usa). */
export async function listMedusaMarketsAsRegions(
  shopUrl: string,
  creds: TokenLike,
): Promise<RegionMap> {
  return marketsToRegions(await medusaConnector.listMarkets(shopUrl, creds));
}
