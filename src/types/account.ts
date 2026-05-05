import type BigNumber from "bignumber.js";
import type {
  PrivateRuntimeReason,
  PrivateRuntimeStatus,
  SubscriptionActivity,
  Venue,
} from "./shared.ts";

export interface AccountDataStatus {
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

export interface AccountStatusChangedEvent {
  type: "account.status_changed";
  accountId: string;
  venue: Venue;
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
  venue?: Venue;
  symbol?: string;
}

export interface BalanceSnapshot {
  accountId: string;
  venue: Venue;
  asset: string;
  free: BigNumber;
  used: BigNumber;
  total: BigNumber;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  seq: number;
  lending?: LendingBalanceFacet;
}

export interface LendingBalanceFacet {
  supplied: BigNumber;
  borrowed: BigNumber;
  interest: BigNumber;
  netAsset: BigNumber;
  supplyAPY?: BigNumber;
  borrowAPY?: BigNumber;
}

export interface PositionSnapshot {
  accountId: string;
  venue: Venue;
  symbol: string;
  side: PositionSide;
  size: BigNumber;
  entryPrice?: BigNumber;
  markPrice?: BigNumber;
  unrealizedPnl?: BigNumber;
  leverage?: BigNumber;
  liquidationPrice?: BigNumber;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  seq: number;
}

export interface RiskSnapshot {
  accountId: string;
  venue: Venue;
  equity?: BigNumber;
  riskRatio?: BigNumber;
  initialMargin?: BigNumber;
  maintenanceMargin?: BigNumber;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  seq: number;
  lending?: LendingRiskFacet;
}

export interface LendingRiskFacet {
  marginLevel?: BigNumber;
  healthFactor?: BigNumber;
  ltv?: BigNumber;
  liquidationThreshold?: BigNumber;
  totalCollateralUSD?: BigNumber;
  totalDebtUSD?: BigNumber;
}

export interface AccountSnapshot {
  accountId: string;
  venue: Venue;
  balances: Record<string, BalanceSnapshot>;
  positions: PositionSnapshot[];
  risk?: RiskSnapshot;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
}

export interface AccountEventBase {
  accountId: string;
  venue: Venue;
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
