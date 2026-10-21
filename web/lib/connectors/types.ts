// Punto centralizado de conectores ecommerce (issue: Shopify/Woo futuros).
// La orquestación (`lib/sync.ts`) programa contra esta interfaz, nunca contra
// `lib/medusa.ts` directo. Hoy solo `medusa` tiene backend; `shopify`/
// `woocommerce` resuelven pero lanzan "sin backend" hasta implementarse.
//
// Barrera: el próximo proveedor = nuevo archivo `connectors/<platform>.ts`
// + 1 línea en `connectors/index.ts`. Si tocas `settings-actions.ts`,
// `sync.ts` o `worker.ts` para agregar un proveedor, la abstracción falló.
import type {
  CanonicalOrder,
  CanonicalProduct,
  CustomersPage,
} from "@/lib/medusa";

export type ConnectorPlatform = "medusa" | "shopify" | "woocommerce";

/**
 * Credenciales por conector (extensible sin romper firmas).
 * - medusa: `{ token }` (JWT post-login).
 * - shopify: `{ token }` (access token; `store` va en shopUrl o `email`).
 * - woocommerce: `{ token: consumer_key, secret: consumer_secret }`.
 * Acepta `string` donde antes había `token` (compat): se normaliza con
 * `toCredentials()`. El próximo proveedor agrega campos opcionales aquí,
 * nunca un nuevo parámetro posicional.
 */
export interface ConnectorCredentials {
  token: string;
  /** Segundo secreto (Woo `consumer_secret`, OAuth refresh, …). */
  secret?: string;
  /** Email/login cuando el flujo lo exige (Medusa). */
  email?: string;
}

export type TokenLike = string | ConnectorCredentials;

export function toCredentials(t: TokenLike): ConnectorCredentials {
  return typeof t === "string" ? { token: t } : t;
}

/** Mercado canónico genérico (no atado a `/admin/regions` de Medusa).
 *  - medusa: region (id → moneda/países).
 *  - shopify: market (`presentmentCurrency + country`, `market_id` inferido).
 *  - woocommerce: sin regiones (lista vacía o mercado único por defecto).
 */
export interface CanonicalMarket {
  sourceId: string;
  name: string;
  currency: string;
  countries: string[];
}

/**
 * @deprecated Usar `CanonicalMarket[]` + `listMarkets()`. Se mantiene por
 * compat con `connectors/medusa.ts` y el caché de `sync.ts`.
 */
export type RegionMap = Record<
  string,
  { name: string; currency: string; countries: string[] }
>;

export function marketsToRegions(markets: CanonicalMarket[]): RegionMap {
  const out: RegionMap = {};
  for (const m of markets) {
    out[m.sourceId] = { name: m.name, currency: m.currency, countries: m.countries };
  }
  return out;
}

export function regionsToMarkets(regions: RegionMap): CanonicalMarket[] {
  return Object.entries(regions).map(([sourceId, r]) => ({
    sourceId,
    name: r.name,
    currency: r.currency,
    countries: r.countries,
  }));
}

export interface ConnectorListOpts {
  offset?: number;
  limit?: number;
  q?: string;
  email?: string;
  /**
   * Versión de API cuando aplica (Medusa v1/v2). Sin sentido para
   * Shopify/Woo: se ignora. Nuevo código → preferir `SyncOptions.version`.
   */
  version?: string;
}

/** Error tipado "plataforma sin backend" (distinguible de un 500 Medusa). */
export class ConnectorNotImplementedError extends Error {
  readonly platform: string;
  constructor(platform: string) {
    super(`Conector '${platform}' aún sin backend (solo medusa implementado).`);
    this.name = "ConnectorNotImplementedError";
    this.platform = platform;
  }
}

export interface ConnectorAuthInput {
  email: string;
  password: string;
  version?: string;
}

export type ConnectorTestResult =
  | { ok: true; store: string }
  | { ok: false; error: string };

export interface EcommerceConnector {
  platform: ConnectorPlatform;
  /** Valores `source` para `channels` / `market_regions` / `products`. */
  marketSource: string;
  channelSource: string;
  productSource: string;
  /**
   * Autentica (login email/password → token). Solo Medusa hoy; el próximo
   * proveedor con OAuth lo implementa aquí en vez de en `settings-actions`.
   */
  authenticate(shopUrl: string, input: ConnectorAuthInput): Promise<string>;
  /** Prueba la conexión con un token existente (lectura mínima). */
  testConnection(
    shopUrl: string,
    creds: TokenLike,
    version?: string,
  ): Promise<ConnectorTestResult>;
  /** Lista mercados en forma canónica (interfaz genérica). */
  listMarkets(shopUrl: string, creds: TokenLike): Promise<CanonicalMarket[]>;
  /**
   * @deprecated Compat Medusa. Nuevo código → `listMarkets()`.
   * El default delega a `listMarkets()` vía `marketsToRegions()`.
   */
  listRegions?(shopUrl: string, creds: TokenLike): Promise<RegionMap>;
  listCustomers(
    shopUrl: string,
    creds: TokenLike,
    opts: ConnectorListOpts,
    version?: string,
  ): Promise<CustomersPage>;
  listOrdersRaw(
    shopUrl: string,
    creds: TokenLike,
    opts: ConnectorListOpts,
  ): Promise<{ orders: Array<Record<string, unknown>>; count: number }>;
  listProductsRaw(
    shopUrl: string,
    creds: TokenLike,
    opts: ConnectorListOpts,
  ): Promise<{ products: Array<Record<string, unknown>>; count: number }>;
  orderToCanonical(
    raw: Record<string, unknown>,
    regions: RegionMap,
  ): CanonicalOrder | null;
  productToCanonical(raw: Record<string, unknown>): CanonicalProduct | null;
}

// Re-export de tipos canónicos para que los conectores futuros importen de aquí.
// Hoy viven en `lib/medusa.ts` / `lib/canonical.ts`; moverlos rompería ~20
// imports (UI, tests, workers). Nuevo código de plataforma → importar de
// `@/lib/connectors`, no de `@/lib/medusa` directo.
export type {
  CanonicalChannelRef,
  CanonicalCustomer,
  CanonicalMarketRef,
  CanonicalOrder,
  CanonicalProduct,
  CurrencyTotals,
  CustomersPage,
  ListCustomersOptions,
  ListOrdersOptions,
  MedusaVersion,
} from "@/lib/medusa";
