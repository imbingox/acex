import type { PositionSide } from "./account.ts";
import type {
  BufferedEventStreamOptions,
  PrivateRuntimeReason,
  PrivateRuntimeStatus,
  SubscriptionActivity,
  Venue,
} from "./shared.ts";

export interface OrderDataStatus {
  accountId: string;
  venue: Venue;
  activity: SubscriptionActivity;
  ready: boolean;
  runtimeStatus?: PrivateRuntimeStatus;
  lastReceivedAt?: number;
  lastReadyAt?: number;
  inactiveSince?: number;
  reason?: PrivateRuntimeReason;
}

export interface OrderStatusChangedEvent {
  type: "order.status_changed";
  accountId: string;
  venue: Venue;
  status: OrderDataStatus;
  ts: number;
}

export type OrderSide = "buy" | "sell";

export type OrderStatus =
  | "open"
  | "partially_filled"
  | "filled"
  | "canceled"
  | "rejected"
  | "expired"
  | "unknown";

export type CreateOrderType = "limit" | "market";

export type OrderType =
  | CreateOrderType
  | "stop"
  | "stop_market"
  | "take_profit"
  | "take_profit_market"
  | "trailing_stop_market"
  | "unknown";

export interface SubscribeOrdersInput {
  accountId: string;
}

export interface UnsubscribeOrdersInput {
  accountId: string;
}

export interface GetOrderInput {
  accountId: string;
  symbol?: string;
  orderId?: string;
  clientOrderId?: string;
}

interface CreateOrderInputBase {
  accountId: string;
  symbol: string;
  side: OrderSide;
  amount: string;
  clientOrderId?: string;
  reduceOnly?: boolean;
  positionSide?: PositionSide;
}

export interface CreateLimitOrderInput extends CreateOrderInputBase {
  type: "limit";
  price: string;
  postOnly?: boolean;
}

export interface CreateMarketOrderInput extends CreateOrderInputBase {
  type: "market";
}

export type CreateOrderInput = CreateLimitOrderInput | CreateMarketOrderInput;

export interface CancelOrderInput {
  accountId: string;
  symbol: string;
  orderId?: string;
  clientOrderId?: string;
}

export interface CancelAllOrdersInput {
  accountId: string;
  symbol: string;
}

export interface OrderEventFilter {
  accountId?: string;
  venue?: Venue;
  symbol?: string;
}

export interface OrderSnapshot {
  accountId: string;
  venue: Venue;
  orderId?: string;
  clientOrderId?: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  rawType?: string;
  status: OrderStatus;
  price?: string;
  triggerPrice?: string;
  amount: string;
  filled: string;
  remaining?: string;
  reduceOnly?: boolean;
  positionSide?: PositionSide;
  avgFillPrice?: string;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  seq: number;
}

export interface OrderTrade {
  tradeId?: string;
  price: string;
  qty: string;
  fee?: {
    cost: string;
    asset: string;
  };
  realizedPnl?: string;
  maker?: boolean;
  positionSide?: PositionSide;
  exchangeTs?: number;
  receivedAt: number;
}

export interface OrderEventBase {
  accountId: string;
  venue: Venue;
  symbol: string;
  ts: number;
}

export interface OrderTradeEvent extends OrderEventBase {
  type: "order.trade";
  side: OrderSide;
  orderId?: string;
  clientOrderId?: string;
  trade: OrderTrade;
  seq: number;
  orderSeq?: number;
}

export interface OrderUpdatedEvent extends OrderEventBase {
  type: "order.updated";
  snapshot: OrderSnapshot;
}

export interface OrderFilledEvent extends OrderEventBase {
  type: "order.filled";
  snapshot: OrderSnapshot;
}

export interface OrderCanceledEvent extends OrderEventBase {
  type: "order.canceled";
  snapshot: OrderSnapshot;
}

export interface OrderRejectedEvent extends OrderEventBase {
  type: "order.rejected";
  snapshot: OrderSnapshot;
}

export interface OrderSnapshotReplacedEvent {
  type: "order.snapshot_replaced";
  accountId: string;
  venue: Venue;
  snapshot: OrderSnapshot[];
  ts: number;
}

export type OrderEvent =
  | OrderUpdatedEvent
  | OrderFilledEvent
  | OrderCanceledEvent
  | OrderRejectedEvent
  | OrderSnapshotReplacedEvent;

export interface OrderEventStreams {
  updates(
    filter?: OrderEventFilter,
    options?: BufferedEventStreamOptions,
  ): AsyncIterable<OrderEvent>;
  trades(
    filter?: OrderEventFilter,
    options?: BufferedEventStreamOptions,
  ): AsyncIterable<OrderTradeEvent>;
  status(
    filter?: OrderEventFilter,
    options?: BufferedEventStreamOptions,
  ): AsyncIterable<OrderStatusChangedEvent>;
}

export interface OrderManager {
  readonly events: OrderEventStreams;

  subscribeOrders(input: SubscribeOrdersInput): Promise<void>;
  unsubscribeOrders(input: UnsubscribeOrdersInput): Promise<void>;
  createOrder(input: CreateOrderInput): Promise<OrderSnapshot>;
  cancelOrder(input: CancelOrderInput): Promise<OrderSnapshot>;
  cancelAllOrders(input: CancelAllOrdersInput): Promise<OrderSnapshot[]>;

  getOrder(input: GetOrderInput): OrderSnapshot | undefined;
  getOpenOrders(accountId: string, symbol?: string): OrderSnapshot[];
  getOrderStatus(accountId: string): OrderDataStatus | undefined;
}
