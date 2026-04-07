import type {
  AccountDataStatus,
  AccountManager,
  AccountStatusChangedEvent,
} from "./account.ts";
import type {
  MarketDataStatus,
  MarketManager,
  MarketStatusChangedEvent,
} from "./market.ts";
import type {
  OrderDataStatus,
  OrderManager,
  OrderStatusChangedEvent,
} from "./order.ts";
import type {
  AccountCredentials,
  AcexInternalError,
  ClientStatus,
  CreateClientOptions,
  Exchange,
  RegisterAccountInput,
  RegisterAccountResult,
  StopOptions,
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
  exchange?: Exchange;
  accountId?: string;
  symbol?: string;
}

export interface ClientEventStreams {
  health(filter?: HealthEventFilter): AsyncIterable<HealthEvent>;
  errors(): AsyncIterable<AcexInternalError>;
}

export interface AcexClient {
  readonly market: MarketManager;
  readonly account: AccountManager;
  readonly order: OrderManager;
  readonly events: ClientEventStreams;

  getStatus(): ClientStatus;
  getHealth(): ClientHealthSnapshot;

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
