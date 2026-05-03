import type BigNumber from "bignumber.js";
import type { PositionSide } from "./account.ts";
import type {
  Exchange,
  PrivateRuntimeReason,
  PrivateRuntimeStatus,
  SubscriptionActivity,
} from "./shared.ts";

export interface OrderDataStatus {
  accountId: string;
  exchange: Exchange;
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
  exchange: Exchange;
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
  | "expired";

export type CreateOrderType = "limit" | "market";

export interface SubscribeOrdersInput {
  accountId: string;
}

export interface UnsubscribeOrdersInput {
  accountId: string;
}

export interface GetOrderInput {
  accountId: string;
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
  exchange?: Exchange;
  symbol?: string;
}

export interface OrderSnapshot {
  accountId: string;
  exchange: Exchange;
  orderId?: string;
  clientOrderId?: string;
  symbol: string;
  side: OrderSide;
  type: string;
  status: OrderStatus;
  price?: BigNumber;
  triggerPrice?: BigNumber;
  amount: BigNumber;
  filled: BigNumber;
  remaining?: BigNumber;
  reduceOnly?: boolean;
  positionSide?: PositionSide;
  avgFillPrice?: BigNumber;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  seq: number;
}

export interface OrderEventBase {
  accountId: string;
  exchange: Exchange;
  symbol: string;
  ts: number;
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
  exchange: Exchange;
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
  updates(filter?: OrderEventFilter): AsyncIterable<OrderEvent>;
  status(filter?: OrderEventFilter): AsyncIterable<OrderStatusChangedEvent>;
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
