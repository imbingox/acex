import type {
  AccountCredentials,
  AccountDataStatus,
  AccountEventFilter,
  AccountSnapshot,
  Exchange,
  FundingRateSnapshot,
  HealthEvent,
  HealthEventFilter,
  L1Book,
  MarketDataStatus,
  MarketEventFilter,
  MarketKeyInput,
  OrderDataStatus,
  OrderEventFilter,
  OrderSnapshot,
} from "../types/index.ts";

export interface RegisteredAccountRecord {
  accountId: string;
  exchange: Exchange;
  credentials?: AccountCredentials;
  options?: Record<string, unknown>;
}

export interface MarketRecord {
  exchange: Exchange;
  symbol: string;
  l1Book?: L1Book;
  fundingRate?: FundingRateSnapshot;
  l1BookSubscribed: boolean;
  fundingRateSubscribed: boolean;
  status: MarketDataStatus;
}

export interface AccountRecord {
  accountId: string;
  exchange: Exchange;
  subscribed: boolean;
  snapshot?: AccountSnapshot;
  status: AccountDataStatus;
}

export interface OrderRecord {
  accountId: string;
  exchange: Exchange;
  subscribed: boolean;
  snapshots: Map<string, OrderSnapshot>;
  status: OrderDataStatus;
}

export function marketKey(input: MarketKeyInput): string {
  return `${input.exchange}:${input.symbol}`;
}

export function sortByJson<T>(values: Iterable<T>): T[] {
  return [...values].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

export function matchesMarketFilter(
  event: { exchange: Exchange; symbol: string },
  filter?: MarketEventFilter,
): boolean {
  if (!filter) {
    return true;
  }

  if (filter.exchange && event.exchange !== filter.exchange) {
    return false;
  }

  if (filter.symbol && event.symbol !== filter.symbol) {
    return false;
  }

  return true;
}

export function matchesAccountFilter(
  event: { accountId: string; exchange: Exchange; symbol?: string },
  filter?: AccountEventFilter,
): boolean {
  if (!filter) {
    return true;
  }

  if (filter.accountId && event.accountId !== filter.accountId) {
    return false;
  }

  if (filter.exchange && event.exchange !== filter.exchange) {
    return false;
  }

  if (filter.symbol && event.symbol !== filter.symbol) {
    return false;
  }

  return true;
}

export function matchesOrderFilter(
  event: { accountId: string; exchange: Exchange; symbol?: string },
  filter?: OrderEventFilter,
): boolean {
  if (!filter) {
    return true;
  }

  if (filter.accountId && event.accountId !== filter.accountId) {
    return false;
  }

  if (filter.exchange && event.exchange !== filter.exchange) {
    return false;
  }

  if (filter.symbol && event.symbol !== filter.symbol) {
    return false;
  }

  return true;
}

export function matchesHealthFilter(
  event: HealthEvent,
  filter?: HealthEventFilter,
): boolean {
  if (!filter) {
    return true;
  }

  if (filter.scope) {
    const actualScope =
      event.type === "client.status_changed"
        ? "client"
        : event.type === "market.status_changed"
          ? "market"
          : event.type === "account.status_changed"
            ? "account"
            : "order";

    if (actualScope !== filter.scope) {
      return false;
    }
  }

  if (
    "exchange" in event &&
    filter.exchange &&
    event.exchange !== filter.exchange
  ) {
    return false;
  }

  if (
    "accountId" in event &&
    filter.accountId &&
    event.accountId !== filter.accountId
  ) {
    return false;
  }

  if ("symbol" in event && filter.symbol && event.symbol !== filter.symbol) {
    return false;
  }

  return true;
}

export function hasPrivateCredentials(
  credentials?: AccountCredentials,
): boolean {
  return Boolean(credentials?.apiKey && credentials.secret);
}

export function mergeCredentials(
  current: AccountCredentials | undefined,
  next: AccountCredentials,
): AccountCredentials {
  return {
    ...current,
    ...next,
    extra: {
      ...(current?.extra ?? {}),
      ...(next.extra ?? {}),
    },
  };
}

export function cloneMarketStatus(status: MarketDataStatus): MarketDataStatus {
  return { ...status };
}

export function cloneAccountStatus(
  status: AccountDataStatus,
): AccountDataStatus {
  return { ...status };
}

export function cloneOrderStatus(status: OrderDataStatus): OrderDataStatus {
  return { ...status };
}
