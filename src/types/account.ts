import type {
  Exchange,
  PrivateRuntimeStatus,
  SubscriptionActivity,
} from "./shared.ts";

export interface AccountDataStatus {
  accountId: string;
  exchange: Exchange;
  activity: SubscriptionActivity;
  ready: boolean;
  runtimeStatus?: PrivateRuntimeStatus;
  lastReceivedAt?: number;
  lastReadyAt?: number;
  inactiveSince?: number;
  reason?:
    | "credentials_missing"
    | "auth_failed"
    | "ws_disconnected"
    | "heartbeat_timeout"
    | "reconciling";
}

export interface AccountStatusChangedEvent {
  type: "account.status_changed";
  accountId: string;
  exchange: Exchange;
  status: AccountDataStatus;
  ts: number;
}

export type PositionSide = "long" | "short" | "net";

export interface SubscribeAccountInput {
  accountId: string;
}

export interface UnsubscribeAccountInput {
  accountId: string;
}

export interface PositionKeyInput {
  accountId: string;
  symbol: string;
  side?: PositionSide;
}

export interface AccountEventFilter {
  accountId?: string;
  exchange?: Exchange;
  symbol?: string;
}

export interface BalanceSnapshot {
  accountId: string;
  exchange: Exchange;
  asset: string;
  free: string;
  used: string;
  total: string;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  seq: number;
}

export interface PositionSnapshot {
  accountId: string;
  exchange: Exchange;
  symbol: string;
  side: PositionSide;
  size: string;
  entryPrice?: string;
  markPrice?: string;
  unrealizedPnl?: string;
  leverage?: string;
  liquidationPrice?: string;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  seq: number;
}

export interface RiskSnapshot {
  accountId: string;
  exchange: Exchange;
  equity?: string;
  marginRatio?: string;
  initialMargin?: string;
  maintenanceMargin?: string;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  seq: number;
}

export interface AccountSnapshot {
  accountId: string;
  exchange: Exchange;
  balances: Record<string, BalanceSnapshot>;
  positions: PositionSnapshot[];
  risk?: RiskSnapshot;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
}

export interface AccountEventBase {
  accountId: string;
  exchange: Exchange;
  ts: number;
}

export interface BalanceUpdatedEvent extends AccountEventBase {
  type: "balance.updated";
  asset: string;
  snapshot: BalanceSnapshot;
}

export interface PositionUpdatedEvent extends AccountEventBase {
  type: "position.updated";
  symbol: string;
  snapshot: PositionSnapshot;
}

export interface RiskUpdatedEvent extends AccountEventBase {
  type: "risk.updated";
  snapshot: RiskSnapshot;
}

export interface AccountSnapshotReplacedEvent extends AccountEventBase {
  type: "account.snapshot_replaced";
  snapshot: AccountSnapshot;
}

export type AccountEvent =
  | BalanceUpdatedEvent
  | PositionUpdatedEvent
  | RiskUpdatedEvent
  | AccountSnapshotReplacedEvent;

export interface AccountEventStreams {
  updates(filter?: AccountEventFilter): AsyncIterable<AccountEvent>;
  status(filter?: AccountEventFilter): AsyncIterable<AccountStatusChangedEvent>;
}

export interface AccountManager {
  readonly events: AccountEventStreams;

  subscribeAccount(input: SubscribeAccountInput): Promise<void>;
  unsubscribeAccount(input: UnsubscribeAccountInput): Promise<void>;

  getAccountSnapshot(accountId: string): AccountSnapshot | undefined;
  getBalances(accountId: string): BalanceSnapshot[];
  getBalance(accountId: string, asset: string): BalanceSnapshot | undefined;
  getPositions(accountId: string, symbol?: string): PositionSnapshot[];
  getPosition(input: PositionKeyInput): PositionSnapshot | undefined;
  getRiskSnapshot(accountId: string): RiskSnapshot | undefined;
  getAccountStatus(accountId: string): AccountDataStatus | undefined;
}
