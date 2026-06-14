import type {
  AccountDataStatus,
  AccountManager,
  AccountStatusChangedEvent,
} from "./account.ts";
import type { FeeManager } from "./fee.ts";
import type {
  MarketDataStatus,
  MarketManager,
  MarketStatusChangedEvent,
} from "./market.ts";
import type {
  CreateOrderType,
  OrderDataStatus,
  OrderManager,
  OrderStatusChangedEvent,
} from "./order.ts";
import type {
  AccountCredentials,
  AcexInternalError,
  BufferedEventStreamOptions,
  ClientStatus,
  CreateClientOptions,
  MarketType,
  RegisterAccountInput,
  RegisterAccountResult,
  StopOptions,
  Venue,
} from "./shared.ts";

export interface ClientHealthSnapshot {
  clientStatus: ClientStatus;
  markets: MarketDataStatus[];
  accounts: AccountDataStatus[];
  orders: OrderDataStatus[];
  updatedAt: number;
}

export interface ClientStatusChangedEvent {
  type: "client.status_changed";
  status: ClientStatus;
  ts: number;
}

export type HealthEvent =
  | ClientStatusChangedEvent
  | MarketStatusChangedEvent
  | AccountStatusChangedEvent
  | OrderStatusChangedEvent;

export interface HealthEventFilter {
  scope?: "client" | "market" | "account" | "order";
  venue?: Venue;
  accountId?: string;
  symbol?: string;
}

export interface ClientEventStreams {
  health(
    filter?: HealthEventFilter,
    options?: BufferedEventStreamOptions,
  ): AsyncIterable<HealthEvent>;
  errors(
    options?: BufferedEventStreamOptions,
  ): AsyncIterable<AcexInternalError>;
}

export type VenueRuntimeStatus = "available" | "type_only" | "reserved";

export type VenueCapabilitySupport = "supported" | "unsupported";

export type VenueCapabilityReason =
  | "not_implemented"
  | "read_only"
  | "market_type_unsupported"
  | "sdk_reserved";

export type FundingRateCapability = VenueCapabilitySupport | "market_dependent";

export type PrivateUpdateCapability = "websocket" | "polling" | "unsupported";

export type CancelAllOrdersCapability = "symbol" | "account" | "unsupported";

export type PositionSideCapability =
  | "optional"
  | "required_for_hedge"
  | "unsupported";

export type OrderTimeInForceCapability = "gtc" | "post_only";

export interface VenueMarketCapabilities {
  catalog: VenueCapabilitySupport;
  serverTime: VenueCapabilitySupport;
  publicTrades: VenueCapabilitySupport;
  publicRawTrades: VenueCapabilitySupport;
  fundingRateHistory: VenueCapabilitySupport;
  l1Book: VenueCapabilitySupport;
  fundingRate: FundingRateCapability;
  marketTypes: MarketType[];
}

export interface VenueAccountCapabilities {
  register: VenueCapabilitySupport;
  snapshot: VenueCapabilitySupport;
  updates: PrivateUpdateCapability;
  balances: VenueCapabilitySupport;
  positions: VenueCapabilitySupport;
  risk: VenueCapabilitySupport;
  lending: VenueCapabilitySupport;
  credentialsRequired: boolean;
}

export interface VenueOrderCapabilities {
  supported: boolean;
  openOrders: VenueCapabilitySupport;
  updates: PrivateUpdateCapability;
  fees: VenueCapabilitySupport;
  create: VenueCapabilitySupport;
  cancel: VenueCapabilitySupport;
  cancelAll: CancelAllOrdersCapability;
  orderTypes: CreateOrderType[];
  timeInForce: OrderTimeInForceCapability[];
  postOnly: boolean;
  reduceOnly: boolean;
  positionSide: PositionSideCapability;
  clientOrderId: boolean;
  reason?: VenueCapabilityReason;
}

export interface VenueCapabilities {
  venue: Venue;
  runtimeStatus: VenueRuntimeStatus;
  readOnly: boolean;
  notes: string[];
  market: VenueMarketCapabilities;
  account: VenueAccountCapabilities;
  order: VenueOrderCapabilities;
}

export interface AcexClient {
  readonly market: MarketManager;
  readonly account: AccountManager;
  readonly order: OrderManager;
  readonly fee: FeeManager;
  readonly events: ClientEventStreams;

  getStatus(): ClientStatus;
  getHealth(): ClientHealthSnapshot;
  getVenueCapabilities(venue: Venue): VenueCapabilities;
  listVenueCapabilities(): VenueCapabilities[];

  registerAccount(input: RegisterAccountInput): Promise<RegisterAccountResult>;
  updateAccountCredentials(
    accountId: string,
    credentials: AccountCredentials,
  ): Promise<void>;
  removeAccount(accountId: string): Promise<void>;

  start(): Promise<void>;
  stop(options?: StopOptions): Promise<void>;
}

export type CreateClient = (options?: CreateClientOptions) => AcexClient;
