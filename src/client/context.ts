import type {
  RawAccountBootstrap,
  RawAccountUpdate,
  RawFundingFeeHistoryResult,
  RawOpenOrdersSnapshot,
  RawOrderUpdate,
  RawRiskLevelChange,
  RawSymbolFeeRate,
  RawSymbolLeverageUpdate,
  RawSymbolRiskLimit,
} from "../adapters/types.ts";
import type { VenueErrorReason } from "../errors.ts";
import type {
  AccountCredentials,
  AcexInternalError,
  CancelAllOrdersInput,
  CancelOrderInput,
  CreateOrderInput,
  FetchFundingFeeHistoryInput,
  FetchRiskLimitsInput,
  GetSymbolFeeRateInput,
  GetSymbolRiskLimitInput,
  HealthEvent,
  MarketDefinition,
  MetricType,
  OrderSnapshot,
  PrivateRuntimeReason,
  PrivateRuntimeStatus,
  SetSymbolLeverageInput,
  Venue,
  VenueOrderCapabilities,
} from "../types/index.ts";

export interface RegisteredAccountRecord {
  accountId: string;
  venue: Venue;
  credentials?: AccountCredentials;
  options?: Record<string, unknown>;
}

export interface FetchFundingFeeHistoryContextInput
  extends Omit<FetchFundingFeeHistoryInput, "symbols"> {
  symbol?: string;
}

export interface ClientContext {
  readonly metricsEnabled: boolean;
  now(): number;
  assertStarted(): void;
  getRegisteredAccount(accountId: string): RegisteredAccountRecord;
  getMarketDefinition(
    venue: Venue,
    symbol: string,
  ): MarketDefinition | undefined;
  getPrivateOrderCapabilities(venue: Venue): VenueOrderCapabilities | undefined;
  normalizeVenueErrorCode(
    venue: Venue,
    code: string,
  ): VenueErrorReason | undefined;
  ensurePrivateCredentials(accountId: string): void;
  subscribePrivateAccountFeed(accountId: string): Promise<void>;
  unsubscribePrivateAccountFeed(accountId: string): void;
  subscribePrivateOrderFeed(accountId: string): Promise<void>;
  unsubscribePrivateOrderFeed(accountId: string): void;
  createOrder(input: CreateOrderInput): Promise<RawOrderUpdate>;
  cancelOrder(input: CancelOrderInput): Promise<RawOrderUpdate>;
  cancelAllOrders(input: CancelAllOrdersInput): Promise<RawOrderUpdate[]>;
  fetchSymbolFeeRate(input: GetSymbolFeeRateInput): Promise<RawSymbolFeeRate>;
  fetchFundingFeeHistory(
    input: FetchFundingFeeHistoryContextInput,
  ): Promise<RawFundingFeeHistoryResult>;
  fetchSymbolRiskLimit?(
    input: GetSymbolRiskLimitInput,
  ): Promise<RawSymbolRiskLimit>;
  fetchRiskLimits?(input: FetchRiskLimitsInput): Promise<RawSymbolRiskLimit[]>;
  setSymbolLeverage?(
    input: SetSymbolLeverageInput,
  ): Promise<RawSymbolLeverageUpdate>;
  publishRuntimeError(
    source: AcexInternalError["source"],
    error: Error,
    metadata?: Omit<AcexInternalError, "error" | "source" | "ts">,
  ): void;
  publishHealthEvent(event: HealthEvent): void;
  emitMetric(
    name: string,
    value: number,
    type: MetricType,
    tags?: Record<string, string>,
  ): void;
}

export interface ManagerLifecycle {
  onClientStarted(): void;
  onClientStopping(now: number): void;
}

export interface AccountAwareManager {
  onAccountRemoved(accountId: string, now: number): void;
  onCredentialsUpdated(accountId: string, venue: Venue): void;
}

export interface HealthReporter<T> {
  getStatuses(): T[];
}

export interface PrivateSubscriptionState {
  runtimeStatus: PrivateRuntimeStatus;
  ready: boolean;
  reason?: PrivateRuntimeReason;
  lastReceivedAt?: number;
  lastReadyAt?: number;
}

export interface ExpiredPendingOrderClaim {
  venueClientOrderId: string;
  localOrderId: string;
  symbol: string;
  claimedAt: number;
}

export interface PrivateAccountDataConsumer {
  onPrivateAccountPending(accountId: string, venue: Venue): void;
  onPrivateAccountBootstrap(
    accountId: string,
    venue: Venue,
    bootstrap: RawAccountBootstrap,
  ): void;
  onPrivateAccountUpdate(
    accountId: string,
    venue: Venue,
    update: RawAccountUpdate,
    options?: { preserveStatus?: boolean; requestStartedAt?: number },
  ): void;
  onPrivateRiskLevelChange(
    accountId: string,
    venue: Venue,
    event: RawRiskLevelChange,
  ): void;
  onPrivateAccountReconcile(
    accountId: string,
    venue: Venue,
    snapshot: RawAccountBootstrap,
    options: { requestStartedAt: number; preserveStatus?: boolean },
  ): void;
  onPrivateAccountStreamState(
    accountId: string,
    venue: Venue,
    state: PrivateSubscriptionState,
  ): void;
}

export interface PrivateOrderDataConsumer {
  onPrivateOrderPending(accountId: string, venue: Venue): void;
  onPrivateOrderBootstrap(
    accountId: string,
    venue: Venue,
    snapshot: RawOpenOrdersSnapshot,
    options: { requestStartedAt: number; preserveStatus?: boolean },
  ): OrderSnapshot[];
  onPrivateOrderReconcile(
    accountId: string,
    venue: Venue,
    snapshot: RawOpenOrdersSnapshot,
    options: { requestStartedAt: number; preserveStatus?: boolean },
  ): OrderSnapshot[];
  onPrivateOrderUpdate(
    accountId: string,
    venue: Venue,
    update: RawOrderUpdate,
    options?: { requestStartedAt?: number; preserveStatus?: boolean },
  ): void;
  onPrivateOrderConfirmedMissing(
    accountId: string,
    venue: Venue,
    order: OrderSnapshot,
  ): void;
  getPrivateOpenOrders(accountId: string): OrderSnapshot[];
  getExpiredPrivateOrderClaims(
    accountId: string,
    now: number,
    ttlMs: number,
  ): ExpiredPendingOrderClaim[];
  onPrivateOrderClaimNotFound(
    accountId: string,
    venue: Venue,
    claim: ExpiredPendingOrderClaim,
  ): void;
  onPrivateOrderStreamState(
    accountId: string,
    venue: Venue,
    state: PrivateSubscriptionState,
  ): void;
}

export function hasPrivateCredentials(
  credentials?: AccountCredentials,
  credentialsRequired = true,
): boolean {
  return credentialsRequired
    ? Boolean(credentials?.apiKey && credentials.secret)
    : true;
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
