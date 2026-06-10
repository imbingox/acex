import type {
  OrderDataStatus,
  OrderSnapshot,
  Venue,
} from "../../types/index.ts";

export interface OrderRecord {
  accountId: string;
  venue: Venue;
  subscribed: boolean;
  openOrders: Map<string, Map<string, OrderSnapshot>>;
  closedOrders: Map<string, Map<string, OrderSnapshot>>;
  localOrderLocations: Map<string, OrderLocation>;
  orderIdIndex: Map<string, Map<string, string>>;
  orderIdOnlyIndex: Map<string, Set<string>>;
  clientOrderIdIndex: Map<string, Set<string>>;
  pendingClientOrderIdIndex: Map<string, PendingOrderClaim>;
  status: OrderDataStatus;
}

export type OrderTable = "open" | "closed";

export interface OrderLocation {
  table: OrderTable;
  symbol: string;
  localOrderId: string;
}

export interface PendingOrderClaim {
  localOrderId: string;
  symbol: string;
}

export interface OrderManagerOptions {
  maxClosedOrdersPerSymbol?: number;
}
