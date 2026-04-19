import type {
  AccountEventFilter,
  Exchange,
  HealthEvent,
  HealthEventFilter,
  MarketEventFilter,
  OrderEventFilter,
} from "../types/index.ts";

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

  if (filter.exchange) {
    if (!("exchange" in event) || event.exchange !== filter.exchange) {
      return false;
    }
  }

  if (filter.accountId) {
    if (!("accountId" in event) || event.accountId !== filter.accountId) {
      return false;
    }
  }

  if (filter.symbol) {
    if (!("symbol" in event) || event.symbol !== filter.symbol) {
      return false;
    }
  }

  return true;
}
