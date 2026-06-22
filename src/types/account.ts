import type {
  BufferedEventStreamOptions,
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

export interface FetchFundingFeeHistoryInput {
  accountId: string;
  symbols?: string[];
  startTs?: number;
  endTs?: number;
  page?: number;
  limit?: number;
}

export interface AccountEventFilter {
  accountId?: string;
  venue?: Venue;
  symbol?: string;
}

export type RiskLevel =
  | "normal"
  | "margin_call"
  | "reduce_only"
  | "force_liquidation";

export type RiskAlertLevel = Exclude<RiskLevel, "normal">;

export interface BalanceSnapshot {
  accountId: string;
  venue: Venue;
  asset: string;
  free: string;
  used: string;
  total: string;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  seq: number;
  lending?: LendingBalanceFacet;
}

export interface LendingBalanceFacet {
  supplied: string;
  borrowed: string;
  interest: string;
  netAsset: string;
  supplyAPY?: string;
  borrowAPY?: string;
}

export interface PositionSnapshot {
  accountId: string;
  venue: Venue;
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
  venue: Venue;
  riskLevel?: RiskLevel;
  netEquity?: string;
  riskEquity?: string;
  riskRatio?: string;
  riskLeverage?: string;
  initialMargin?: string;
  maintenanceMargin?: string;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  seq: number;
  lending?: LendingRiskFacet;
}

export interface FundingFeeHistoryEntry {
  accountId: string;
  venue: Venue;
  symbol: string;
  asset: string;
  amount: string;
  fundingTime: number;
  receivedAt: number;
  venueTransactionId?: string;
  tradeId?: string;
  positionSide?: PositionSide;
  raw: Record<string, unknown>;
}

export interface FetchFundingFeeHistoryResult {
  fees: FundingFeeHistoryEntry[];
  startTs?: number;
  endTs?: number;
  page: number;
  limit: number;
  truncated: boolean;
  nextPage?: number;
}

export interface LendingRiskFacet {
  marginLevel?: string;
  healthFactor?: string;
  ltv?: string;
  liquidationThreshold?: string;
  totalCollateralUSD?: string;
  totalDebtUSD?: string;
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

export interface RiskLevelChangedEvent extends AccountEventBase {
  type: "account.risk_level_change";
  riskLevel: RiskAlertLevel;
  riskRatio?: string;
  netEquity?: string;
  riskEquity?: string;
  riskLeverage?: string;
  maintenanceMargin?: string;
  exchangeTs?: number;
  receivedAt: number;
}

export interface AccountSnapshotReplacedEvent extends AccountEventBase {
  type: "account.snapshot_replaced";
  snapshot: AccountSnapshot;
}

export type AccountEvent =
  | BalanceUpdatedEvent
  | PositionUpdatedEvent
  | RiskUpdatedEvent
  | RiskLevelChangedEvent
  | AccountSnapshotReplacedEvent;

export interface AccountEventStreams {
  updates(
    filter?: AccountEventFilter,
    options?: BufferedEventStreamOptions,
  ): AsyncIterable<AccountEvent>;
  status(
    filter?: AccountEventFilter,
    options?: BufferedEventStreamOptions,
  ): AsyncIterable<AccountStatusChangedEvent>;
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
  fetchFundingFeeHistory(
    input: FetchFundingFeeHistoryInput,
  ): Promise<FetchFundingFeeHistoryResult>;
}
