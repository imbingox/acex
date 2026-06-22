import BigNumber from "bignumber.js";
import type {
  RawAccountBootstrap,
  RawAccountUpdate,
  RawBalanceUpdate,
  RawFundingFeeHistoryEntry,
  RawPositionUpdate,
  RawRiskLevelChange,
  RawRiskUpdate,
} from "../adapters/types.ts";
import type {
  AccountAwareManager,
  ClientContext,
  HealthReporter,
  ManagerLifecycle,
  PrivateAccountDataConsumer,
  PrivateSubscriptionState,
} from "../client/context.ts";
import type { AcexErrorDetails } from "../errors.ts";
import {
  AcexError,
  buildAcexErrorDetails,
  formatAcexErrorMessage,
} from "../errors.ts";
import type { AsyncEventBusOverflowInfo } from "../internal/async-event-bus.ts";
import { AsyncEventBus } from "../internal/async-event-bus.ts";
import { toCanonical } from "../internal/decimal.ts";
import { matchesAccountFilter } from "../internal/filters.ts";
import {
  canDeleteMissingFromSnapshot,
  shouldApplyWatermarkedUpdate,
} from "../internal/watermark.ts";
import type {
  AccountDataStatus,
  AccountEvent,
  AccountEventStreams,
  AccountManager,
  AccountSnapshot,
  AccountSnapshotReplacedEvent,
  AccountStatusChangedEvent,
  BalanceSnapshot,
  FetchFundingFeeHistoryInput,
  FetchFundingFeeHistoryResult,
  FundingFeeHistoryEntry,
  PositionKeyInput,
  PositionSnapshot,
  RiskLevelChangedEvent,
  RiskSnapshot,
  SubscribeAccountInput,
  UnsubscribeAccountInput,
  Venue,
} from "../types/index.ts";
import { METRIC_NAMES } from "../types/index.ts";

interface AccountRecord {
  accountId: string;
  venue: Venue;
  subscribed: boolean;
  snapshot?: AccountSnapshot;
  status: AccountDataStatus;
}

interface FundingFeeFetchMetadata {
  accountId: string;
  venue: Venue;
  symbol?: string;
}

interface NormalizedFundingFeeHistoryInput {
  accountId: string;
  symbols?: string[];
  startTs?: number;
  endTs?: number;
  page: number;
  limit: number;
}

const DEFAULT_FUNDING_FEE_HISTORY_PAGE = 1;
const DEFAULT_FUNDING_FEE_HISTORY_LIMIT = 1_000;
const MAX_FUNDING_FEE_HISTORY_LIMIT = 1_000;
const FUNDING_FEE_HISTORY_ACCOUNT_SCAN_THRESHOLD = 5;

function cloneAccountStatus(status: AccountDataStatus): AccountDataStatus {
  return { ...status };
}

function compareFundingFeeHistoryEntries(
  left: FundingFeeHistoryEntry,
  right: FundingFeeHistoryEntry,
): number {
  if (left.fundingTime !== right.fundingTime) {
    return left.fundingTime - right.fundingTime;
  }

  const symbolComparison = left.symbol.localeCompare(right.symbol);
  if (symbolComparison !== 0) {
    return symbolComparison;
  }

  return (left.venueTransactionId ?? "").localeCompare(
    right.venueTransactionId ?? "",
  );
}

function positionKey(symbol: string, side: PositionSnapshot["side"]): string {
  return `${symbol}:${side}`;
}

function getBigNumber(
  value: string | undefined,
  fallback: BigNumber,
): BigNumber {
  return value === undefined ? fallback : new BigNumber(value);
}

function isZeroDecimal(value: string): boolean {
  return new BigNumber(value).isZero();
}

function calculateSnapshotRiskLeverage(
  riskEquity: string | undefined,
  positions: Iterable<PositionSnapshot>,
): string | undefined {
  if (!riskEquity) {
    return undefined;
  }

  const riskEquityValue = new BigNumber(riskEquity);
  if (!riskEquityValue.isFinite() || riskEquityValue.isZero()) {
    return undefined;
  }

  let grossExposure = new BigNumber(0);
  for (const position of positions) {
    const size = new BigNumber(position.size);
    if (!size.isFinite()) {
      return undefined;
    }
    if (size.isZero()) {
      continue;
    }

    if (!position.markPrice) {
      return undefined;
    }

    const markPrice = new BigNumber(position.markPrice);
    if (!markPrice.isFinite()) {
      return undefined;
    }

    grossExposure = grossExposure.plus(
      size.multipliedBy(markPrice).absoluteValue(),
    );
  }

  return grossExposure.isZero()
    ? "0"
    : grossExposure.dividedBy(riskEquityValue).toString(10);
}

function isZeroBalance(balance: BalanceSnapshot): boolean {
  return (
    isZeroDecimal(balance.free) &&
    isZeroDecimal(balance.used) &&
    isZeroDecimal(balance.total)
  );
}

function freezeBalance(balance: BalanceSnapshot): BalanceSnapshot {
  return Object.freeze({
    ...balance,
    lending: balance.lending
      ? Object.freeze({ ...balance.lending })
      : undefined,
  });
}

function freezePosition(position: PositionSnapshot): PositionSnapshot {
  return Object.freeze({ ...position });
}

function freezeRisk(risk: RiskSnapshot): RiskSnapshot {
  return Object.freeze({
    ...risk,
    lending: risk.lending ? Object.freeze({ ...risk.lending }) : undefined,
  });
}

function freezeAccountSnapshot(snapshot: AccountSnapshot): AccountSnapshot {
  return Object.freeze({
    ...snapshot,
    balances: Object.freeze({ ...snapshot.balances }) as Record<
      string,
      BalanceSnapshot
    >,
    positions: Object.freeze([...snapshot.positions]) as PositionSnapshot[],
  });
}

function successfulStatus(
  status: AccountDataStatus,
  options: {
    ready?: boolean;
    lastReceivedAt?: number;
    lastReadyAt?: number;
    preserveStatus?: boolean;
  },
): AccountDataStatus {
  const preservesStreamState =
    options.preserveStatus &&
    (status.runtimeStatus === "reconnecting" ||
      status.reason === "ws_disconnected" ||
      status.reason === "heartbeat_timeout");
  const ready = options.ready ?? true;

  return {
    ...status,
    activity: "active",
    ready,
    runtimeStatus: preservesStreamState ? status.runtimeStatus : "healthy",
    reason: preservesStreamState ? status.reason : undefined,
    lastReceivedAt: options.lastReceivedAt ?? status.lastReceivedAt,
    lastReadyAt: ready
      ? (options.lastReadyAt ??
        (options.preserveStatus ? status.lastReadyAt : undefined) ??
        Date.now())
      : status.lastReadyAt,
    inactiveSince: undefined,
  };
}

export class AccountManagerImpl
  implements
    AccountManager,
    ManagerLifecycle,
    AccountAwareManager,
    HealthReporter<AccountDataStatus>,
    PrivateAccountDataConsumer
{
  readonly events: AccountEventStreams;

  private readonly context: ClientContext;
  private readonly accountBus = new AsyncEventBus<AccountEvent>();
  private readonly accountStatusBus =
    new AsyncEventBus<AccountStatusChangedEvent>();
  private readonly records = new Map<string, AccountRecord>();

  constructor(context: ClientContext) {
    this.context = context;

    this.events = {
      status: (filter, options) =>
        this.accountStatusBus.stream(
          (event) =>
            matchesAccountFilter(
              { accountId: event.accountId, venue: event.venue },
              filter,
            ),
          {
            maxBuffer: options?.maxBuffer,
            onOverflow: this.createOverflowHandler("account.status"),
          },
        ),
      updates: (filter, options) =>
        this.accountBus.stream(
          (event) =>
            matchesAccountFilter(
              {
                accountId: event.accountId,
                venue: event.venue,
                symbol: "symbol" in event ? event.symbol : undefined,
              },
              filter,
            ),
          {
            maxBuffer: options?.maxBuffer,
            onOverflow: this.createOverflowHandler("account.updates"),
          },
        ),
    };
  }

  // --- AccountManager public API ---

  async subscribeAccount(input: SubscribeAccountInput): Promise<void> {
    this.context.assertStarted();
    const account = this.context.getRegisteredAccount(input.accountId);
    this.context.ensurePrivateCredentials(input.accountId);

    const record = this.getOrCreateRecord(input.accountId, account.venue);
    record.subscribed = true;

    try {
      await this.context.subscribePrivateAccountFeed(input.accountId);
    } catch (error) {
      record.subscribed = false;
      throw error;
    }
  }

  async unsubscribeAccount(input: UnsubscribeAccountInput): Promise<void> {
    const record = this.records.get(input.accountId);
    if (!record?.subscribed) {
      return;
    }

    this.context.unsubscribePrivateAccountFeed(input.accountId);
    record.subscribed = false;
    record.status = {
      ...record.status,
      activity: "inactive",
      runtimeStatus: "stopped",
      reason: undefined,
      inactiveSince: this.context.now(),
    };
    this.publishStatus(record);
  }

  getAccountSnapshot(accountId: string): AccountSnapshot | undefined {
    return this.records.get(accountId)?.snapshot;
  }

  getBalance(accountId: string, asset: string): BalanceSnapshot | undefined {
    return this.records.get(accountId)?.snapshot?.balances[asset];
  }

  getBalances(accountId: string): BalanceSnapshot[] {
    const balances = this.records.get(accountId)?.snapshot?.balances;
    return balances ? Object.values(balances) : [];
  }

  getPosition(input: PositionKeyInput): PositionSnapshot | undefined {
    return this.getPositions(input.accountId, input.symbol).find(
      (position) => input.side === undefined || position.side === input.side,
    );
  }

  getPositions(accountId: string, symbol?: string): PositionSnapshot[] {
    const positions = this.records.get(accountId)?.snapshot?.positions ?? [];
    if (!symbol) {
      return [...positions];
    }
    return positions.filter((position) => position.symbol === symbol);
  }

  getRiskSnapshot(accountId: string): RiskSnapshot | undefined {
    return this.records.get(accountId)?.snapshot?.risk;
  }

  getAccountStatus(accountId: string): AccountDataStatus | undefined {
    const status = this.records.get(accountId)?.status;
    return status ? cloneAccountStatus(status) : undefined;
  }

  async fetchFundingFeeHistory(
    input: FetchFundingFeeHistoryInput,
  ): Promise<FetchFundingFeeHistoryResult> {
    this.context.assertStarted();
    const account = this.context.getRegisteredAccount(input.accountId);
    const normalized = this.normalizeFundingFeeHistoryInput(input, {
      accountId: account.accountId,
      venue: account.venue,
    });

    if (normalized.symbols?.length === 0) {
      return this.createFundingFeeHistoryResult(normalized, [], false);
    }

    if (normalized.symbols === undefined) {
      return await this.fetchAccountFundingFeeHistory(normalized, {
        accountId: account.accountId,
        venue: account.venue,
      });
    }

    const symbols = normalized.symbols;
    if (symbols.length <= FUNDING_FEE_HISTORY_ACCOUNT_SCAN_THRESHOLD) {
      return await this.fetchPerSymbolFundingFeeHistory(
        { ...normalized, symbols },
        {
          accountId: account.accountId,
          venue: account.venue,
        },
      );
    }

    const targetSymbols = new Set(symbols);
    const result = await this.fetchAccountFundingFeeHistory(normalized, {
      accountId: account.accountId,
      venue: account.venue,
    });

    return {
      ...result,
      fees: result.fees.filter((fee) => targetSymbols.has(fee.symbol)),
    };
  }

  // --- ManagerLifecycle ---

  onClientStarted(): void {}

  onClientStopping(now: number): void {
    for (const record of this.records.values()) {
      if (!record.subscribed) {
        continue;
      }

      record.status = {
        ...record.status,
        activity: "inactive",
        runtimeStatus: "stopped",
        reason: undefined,
        inactiveSince: now,
      };
      this.publishStatus(record);
    }
  }

  // --- AccountAwareManager ---

  onAccountRemoved(accountId: string, now: number): void {
    const record = this.records.get(accountId);
    if (!record) {
      return;
    }

    record.subscribed = false;
    record.status = {
      ...record.status,
      activity: "inactive",
      runtimeStatus: "stopped",
      reason: undefined,
      inactiveSince: now,
    };
    this.publishStatus(record);
    this.records.delete(accountId);
  }

  onCredentialsUpdated(accountId: string, venue: Venue): void {
    const record = this.records.get(accountId);
    if (!record?.subscribed) {
      return;
    }

    this.onPrivateAccountPending(accountId, venue);
  }

  // --- PrivateAccountDataConsumer ---

  onPrivateAccountPending(accountId: string, venue: Venue): void {
    const record = this.getOrCreateRecord(accountId, venue);
    if (!record.subscribed) {
      return;
    }

    record.status = {
      ...this.createStatus(accountId, venue, "active"),
      ready: Boolean(record.snapshot),
      runtimeStatus: "bootstrap_pending",
      reason: undefined,
      lastReceivedAt: record.snapshot?.updatedAt,
      lastReadyAt: record.snapshot?.updatedAt,
      inactiveSince: undefined,
    };
    this.publishStatus(record);
  }

  onPrivateAccountBootstrap(
    accountId: string,
    venue: Venue,
    bootstrap: RawAccountBootstrap,
  ): void {
    const record = this.getOrCreateRecord(accountId, venue);
    if (!record.subscribed) {
      return;
    }

    record.snapshot = this.createBootstrapSnapshot(accountId, venue, bootstrap);
    record.status = {
      ...record.status,
      activity: "active",
      ready: true,
      runtimeStatus: "healthy",
      reason: undefined,
      lastReceivedAt: record.snapshot.receivedAt,
      lastReadyAt: record.snapshot.updatedAt,
      inactiveSince: undefined,
    };

    const event: AccountSnapshotReplacedEvent = {
      type: "account.snapshot_replaced",
      accountId,
      venue,
      snapshot: record.snapshot,
      ts: this.context.now(),
    };

    this.accountBus.publish(event);
    this.publishStatus(record);
  }

  onPrivateAccountUpdate(
    accountId: string,
    venue: Venue,
    update: RawAccountUpdate,
    options: { preserveStatus?: boolean; requestStartedAt?: number } = {},
  ): void {
    const record = this.getOrCreateRecord(accountId, venue);
    if (!record.subscribed) {
      return;
    }

    const previous =
      record.snapshot ?? this.createEmptySnapshot(accountId, venue);
    const balances = { ...previous.balances };
    const positions = new Map(
      previous.positions.map((position) => [
        positionKey(position.symbol, position.side),
        position,
      ]),
    );
    let risk = previous.risk;

    let latestAppliedAt = 0;
    let appliedSizePositionUpdate = false;
    for (const balance of update.balances ?? []) {
      if (
        !shouldApplyWatermarkedUpdate(balances[balance.asset], balance, {
          requestStartedAt: options.requestStartedAt,
          source: options.requestStartedAt === undefined ? "stream" : "rest",
        })
      ) {
        continue;
      }

      const nextBalance = this.createBalance(
        accountId,
        venue,
        balance,
        balances[balance.asset],
      );
      balances[balance.asset] = nextBalance;
      latestAppliedAt = Math.max(latestAppliedAt, nextBalance.receivedAt);
      this.accountBus.publish({
        type: "balance.updated",
        accountId,
        venue,
        asset: balance.asset,
        snapshot: nextBalance,
        ts: this.context.now(),
      });
    }

    for (const position of update.positions ?? []) {
      const key = positionKey(position.symbol, position.side);
      const previousPosition = positions.get(key);
      if (position.size === undefined && !previousPosition) {
        continue;
      }
      if (
        !shouldApplyWatermarkedUpdate(previousPosition, position, {
          requestStartedAt: options.requestStartedAt,
          source: options.requestStartedAt === undefined ? "stream" : "rest",
        })
      ) {
        continue;
      }

      const nextPosition = this.createPosition(
        accountId,
        venue,
        position,
        previousPosition,
      );

      if (isZeroDecimal(nextPosition.size)) {
        positions.delete(key);
      } else {
        positions.set(key, nextPosition);
      }

      if (position.size !== undefined) {
        appliedSizePositionUpdate = true;
      }
      latestAppliedAt = Math.max(latestAppliedAt, nextPosition.receivedAt);
      this.accountBus.publish({
        type: "position.updated",
        accountId,
        venue,
        symbol: position.symbol,
        snapshot: nextPosition,
        ts: this.context.now(),
      });
    }

    let riskUpdate = update.risk;
    if (options.requestStartedAt === undefined && appliedSizePositionUpdate) {
      const riskLeverage = calculateSnapshotRiskLeverage(
        riskUpdate?.riskEquity ?? previous.risk?.riskEquity,
        positions.values(),
      );
      if (riskLeverage !== undefined) {
        riskUpdate = {
          ...riskUpdate,
          riskLeverage,
          exchangeTs: riskUpdate?.exchangeTs ?? update.exchangeTs,
          receivedAt: riskUpdate?.receivedAt ?? update.receivedAt,
        };
      }
    }

    if (
      riskUpdate &&
      shouldApplyWatermarkedUpdate(previous.risk, riskUpdate, {
        requestStartedAt: options.requestStartedAt,
        source: options.requestStartedAt === undefined ? "stream" : "rest",
      })
    ) {
      risk = this.createRisk(accountId, venue, riskUpdate, previous.risk);
      latestAppliedAt = Math.max(latestAppliedAt, risk.receivedAt);
      this.accountBus.publish({
        type: "risk.updated",
        accountId,
        venue,
        snapshot: risk,
        ts: this.context.now(),
      });
    }

    if (latestAppliedAt === 0) {
      return;
    }

    record.snapshot = freezeAccountSnapshot({
      accountId,
      venue,
      balances,
      positions: [...positions.values()],
      risk,
      exchangeTs:
        update.exchangeTs === undefined
          ? previous.exchangeTs
          : update.exchangeTs,
      receivedAt: latestAppliedAt,
      updatedAt: latestAppliedAt,
    });
    record.status = successfulStatus(record.status, {
      preserveStatus: options.preserveStatus,
      lastReceivedAt: latestAppliedAt,
      lastReadyAt: latestAppliedAt,
    });
    this.publishStatus(record);
  }

  onPrivateRiskLevelChange(
    accountId: string,
    venue: Venue,
    event: RawRiskLevelChange,
  ): void {
    const record = this.getOrCreateRecord(accountId, venue);
    if (!record.subscribed) {
      return;
    }

    const previous =
      record.snapshot ?? this.createEmptySnapshot(accountId, venue);
    const riskLeverage = calculateSnapshotRiskLeverage(
      event.riskEquity ?? previous.risk?.riskEquity,
      previous.positions,
    );
    const riskEvent: RiskLevelChangedEvent = {
      type: "account.risk_level_change",
      accountId,
      venue,
      riskLevel: event.riskLevel,
      riskRatio: event.riskRatio,
      netEquity: event.netEquity,
      riskEquity: event.riskEquity,
      riskLeverage,
      maintenanceMargin: event.maintenanceMargin,
      exchangeTs: event.exchangeTs,
      receivedAt: event.receivedAt,
      ts: this.context.now(),
    };
    this.accountBus.publish(riskEvent);

    const riskUpdate: RawRiskUpdate = {
      riskLevel: event.riskLevel,
      riskRatio: event.riskRatio,
      netEquity: event.netEquity,
      riskEquity: event.riskEquity,
      riskLeverage,
      maintenanceMargin: event.maintenanceMargin,
      exchangeTs: event.exchangeTs,
      receivedAt: event.receivedAt,
    };

    if (
      shouldApplyWatermarkedUpdate(previous.risk, riskUpdate, {
        source: "stream",
      })
    ) {
      const risk = this.createRisk(accountId, venue, riskUpdate, previous.risk);
      record.snapshot = freezeAccountSnapshot({
        accountId,
        venue,
        balances: previous.balances,
        positions: previous.positions,
        risk,
        exchangeTs:
          event.exchangeTs === undefined
            ? previous.exchangeTs
            : event.exchangeTs,
        receivedAt: event.receivedAt,
        updatedAt: event.receivedAt,
      });
      this.accountBus.publish({
        type: "risk.updated",
        accountId,
        venue,
        snapshot: risk,
        ts: this.context.now(),
      });
    }

    record.status = successfulStatus(record.status, {
      lastReceivedAt: event.receivedAt,
      lastReadyAt: event.receivedAt,
    });
    this.publishStatus(record);
  }

  onPrivateAccountReconcile(
    accountId: string,
    venue: Venue,
    snapshot: RawAccountBootstrap,
    options: { requestStartedAt: number; preserveStatus?: boolean },
  ): void {
    const record = this.getOrCreateRecord(accountId, venue);
    if (!record.subscribed) {
      return;
    }

    const previous =
      record.snapshot ?? this.createEmptySnapshot(accountId, venue);
    const balances = { ...previous.balances };
    const positions = new Map(
      previous.positions.map((position) => [
        positionKey(position.symbol, position.side),
        position,
      ]),
    );
    let risk = previous.risk;

    const incomingBalanceAssets = new Set<string>();
    for (const balance of snapshot.balances) {
      incomingBalanceAssets.add(balance.asset);
      if (
        !shouldApplyWatermarkedUpdate(balances[balance.asset], balance, {
          requestStartedAt: options.requestStartedAt,
          source: "rest",
        })
      ) {
        continue;
      }

      const nextBalance = this.createBalance(
        accountId,
        venue,
        balance,
        balances[balance.asset],
      );
      if (isZeroBalance(nextBalance)) {
        delete balances[balance.asset];
      } else {
        balances[balance.asset] = nextBalance;
      }
    }

    for (const [asset, balance] of Object.entries(balances)) {
      if (
        (!incomingBalanceAssets.has(asset) || isZeroBalance(balance)) &&
        canDeleteMissingFromSnapshot(balance, {
          requestStartedAt: options.requestStartedAt,
          snapshotExchangeTs: snapshot.exchangeTs,
        })
      ) {
        delete balances[asset];
      }
    }

    const incomingPositionKeys = new Set<string>();
    for (const position of snapshot.positions) {
      const key = positionKey(position.symbol, position.side);
      incomingPositionKeys.add(key);
      if (
        !shouldApplyWatermarkedUpdate(positions.get(key), position, {
          requestStartedAt: options.requestStartedAt,
          source: "rest",
        })
      ) {
        continue;
      }

      const nextPosition = this.createPosition(
        accountId,
        venue,
        position,
        positions.get(key),
      );
      if (isZeroDecimal(nextPosition.size)) {
        positions.delete(key);
      } else {
        positions.set(key, nextPosition);
      }
    }

    for (const [key, position] of positions.entries()) {
      if (
        !incomingPositionKeys.has(key) &&
        canDeleteMissingFromSnapshot(position, {
          requestStartedAt: options.requestStartedAt,
          snapshotExchangeTs: snapshot.exchangeTs,
        })
      ) {
        positions.delete(key);
      }
    }

    if (
      snapshot.risk &&
      shouldApplyWatermarkedUpdate(previous.risk, snapshot.risk, {
        requestStartedAt: options.requestStartedAt,
        source: "rest",
      })
    ) {
      risk = this.createRisk(accountId, venue, snapshot.risk, previous.risk);
    }

    record.snapshot = freezeAccountSnapshot({
      accountId,
      venue,
      balances,
      positions: [...positions.values()],
      risk,
      exchangeTs:
        snapshot.exchangeTs === undefined
          ? previous.exchangeTs
          : snapshot.exchangeTs,
      receivedAt: snapshot.receivedAt,
      updatedAt: snapshot.receivedAt,
    });
    record.status = successfulStatus(record.status, {
      preserveStatus: options.preserveStatus,
      lastReceivedAt: snapshot.receivedAt,
      lastReadyAt: snapshot.receivedAt,
    });

    const event: AccountSnapshotReplacedEvent = {
      type: "account.snapshot_replaced",
      accountId,
      venue,
      snapshot: record.snapshot,
      ts: this.context.now(),
    };

    this.accountBus.publish(event);
    this.publishStatus(record);
  }

  onPrivateAccountStreamState(
    accountId: string,
    venue: Venue,
    state: PrivateSubscriptionState,
  ): void {
    const record = this.getOrCreateRecord(accountId, venue);
    if (!record.subscribed) {
      return;
    }

    record.status = {
      ...record.status,
      activity: "active",
      ready: state.ready,
      runtimeStatus: state.runtimeStatus,
      reason: state.reason,
      lastReceivedAt: state.lastReceivedAt ?? record.status.lastReceivedAt,
      lastReadyAt: state.lastReadyAt ?? record.status.lastReadyAt,
      inactiveSince: undefined,
    };
    this.publishStatus(record);
  }

  // --- HealthReporter ---

  getStatuses(): AccountDataStatus[] {
    return [...this.records.values()]
      .map((record) => cloneAccountStatus(record.status))
      .sort((left, right) =>
        `${left.venue}:${left.accountId}`.localeCompare(
          `${right.venue}:${right.accountId}`,
        ),
      );
  }

  // --- Internal helpers ---

  private getOrCreateRecord(accountId: string, venue: Venue): AccountRecord {
    const existing = this.records.get(accountId);
    if (existing) {
      return existing;
    }

    const record: AccountRecord = {
      accountId,
      venue,
      subscribed: false,
      status: this.createStatus(accountId, venue, "inactive"),
    };

    this.records.set(accountId, record);
    return record;
  }

  private createStatus(
    accountId: string,
    venue: Venue,
    activity: "active" | "inactive",
  ): AccountDataStatus {
    return {
      accountId,
      venue,
      activity,
      ready: false,
      runtimeStatus: activity === "active" ? "bootstrap_pending" : "stopped",
    };
  }

  private createBootstrapSnapshot(
    accountId: string,
    venue: Venue,
    bootstrap: RawAccountBootstrap,
  ): AccountSnapshot {
    const balances = Object.fromEntries(
      bootstrap.balances.map((balance) => [
        balance.asset,
        this.createBalance(accountId, venue, balance),
      ]),
    );
    const positions = bootstrap.positions
      .map((position) => this.createPosition(accountId, venue, position))
      .filter((position) => !isZeroDecimal(position.size));
    const risk = bootstrap.risk
      ? this.createRisk(accountId, venue, bootstrap.risk)
      : undefined;

    return freezeAccountSnapshot({
      accountId,
      venue,
      balances,
      positions,
      risk,
      exchangeTs: bootstrap.exchangeTs,
      receivedAt: bootstrap.receivedAt,
      updatedAt: bootstrap.receivedAt,
    });
  }

  private createEmptySnapshot(
    accountId: string,
    venue: Venue,
  ): AccountSnapshot {
    const now = this.context.now();
    return freezeAccountSnapshot({
      accountId,
      venue,
      balances: {},
      positions: [],
      receivedAt: now,
      updatedAt: now,
    });
  }

  private createBalance(
    accountId: string,
    venue: Venue,
    input: RawBalanceUpdate,
    previous?: BalanceSnapshot,
  ): BalanceSnapshot {
    const previousFree = new BigNumber(previous?.free ?? 0);
    const previousUsed = new BigNumber(previous?.used ?? 0);
    const previousTotal =
      previous?.total === undefined
        ? previousFree.plus(previousUsed)
        : new BigNumber(previous.total);
    const free = getBigNumber(input.free, previousFree);
    const total = getBigNumber(input.total, previousTotal);
    const used =
      input.used !== undefined
        ? new BigNumber(input.used)
        : input.total !== undefined || input.free !== undefined
          ? total.minus(free)
          : previousUsed;

    return freezeBalance({
      accountId,
      venue,
      asset: input.asset,
      free: toCanonical(free),
      used: toCanonical(used),
      total: toCanonical(total),
      exchangeTs: input.exchangeTs,
      receivedAt: input.receivedAt,
      updatedAt: input.receivedAt,
      seq: (previous?.seq ?? 0) + 1,
      lending: input.lending
        ? {
            supplied: toCanonical(
              input.lending.supplied ?? previous?.lending?.supplied ?? "0",
            ),
            borrowed: toCanonical(
              input.lending.borrowed ?? previous?.lending?.borrowed ?? "0",
            ),
            interest: toCanonical(
              input.lending.interest ?? previous?.lending?.interest ?? "0",
            ),
            netAsset: toCanonical(
              input.lending.netAsset ?? previous?.lending?.netAsset ?? "0",
            ),
            supplyAPY:
              input.lending.supplyAPY === undefined
                ? previous?.lending?.supplyAPY
                : toCanonical(input.lending.supplyAPY),
            borrowAPY:
              input.lending.borrowAPY === undefined
                ? previous?.lending?.borrowAPY
                : toCanonical(input.lending.borrowAPY),
          }
        : previous?.lending,
    });
  }

  private createPosition(
    accountId: string,
    venue: Venue,
    input: RawPositionUpdate,
    previous?: PositionSnapshot,
  ): PositionSnapshot {
    return freezePosition({
      accountId,
      venue,
      symbol: input.symbol,
      side: input.side,
      size:
        input.size === undefined
          ? (previous?.size ?? "0")
          : toCanonical(input.size),
      entryPrice:
        input.entryPrice === undefined
          ? previous?.entryPrice
          : toCanonical(input.entryPrice),
      markPrice:
        input.markPrice === undefined
          ? previous?.markPrice
          : toCanonical(input.markPrice),
      unrealizedPnl:
        input.unrealizedPnl === undefined
          ? previous?.unrealizedPnl
          : toCanonical(input.unrealizedPnl),
      leverage:
        input.leverage === undefined
          ? previous?.leverage
          : toCanonical(input.leverage),
      liquidationPrice:
        input.liquidationPrice === undefined
          ? previous?.liquidationPrice
          : toCanonical(input.liquidationPrice),
      exchangeTs: input.exchangeTs,
      receivedAt: input.receivedAt,
      updatedAt: input.receivedAt,
      seq: (previous?.seq ?? 0) + 1,
    });
  }

  private createRisk(
    accountId: string,
    venue: Venue,
    input: RawRiskUpdate,
    previous?: RiskSnapshot,
  ): RiskSnapshot {
    return freezeRisk({
      accountId,
      venue,
      riskLevel:
        input.riskLevel === undefined ? previous?.riskLevel : input.riskLevel,
      netEquity:
        input.netEquity === undefined
          ? previous?.netEquity
          : toCanonical(input.netEquity),
      riskEquity:
        input.riskEquity === undefined
          ? previous?.riskEquity
          : toCanonical(input.riskEquity),
      riskRatio:
        input.riskRatio === undefined
          ? previous?.riskRatio
          : toCanonical(input.riskRatio),
      riskLeverage:
        input.riskLeverage === undefined
          ? previous?.riskLeverage
          : toCanonical(input.riskLeverage),
      initialMargin:
        input.initialMargin === undefined
          ? previous?.initialMargin
          : toCanonical(input.initialMargin),
      maintenanceMargin:
        input.maintenanceMargin === undefined
          ? previous?.maintenanceMargin
          : toCanonical(input.maintenanceMargin),
      exchangeTs: input.exchangeTs,
      receivedAt: input.receivedAt,
      updatedAt: input.receivedAt,
      seq: (previous?.seq ?? 0) + 1,
      lending: input.lending
        ? {
            marginLevel:
              input.lending.marginLevel === undefined
                ? undefined
                : toCanonical(input.lending.marginLevel),
            healthFactor:
              input.lending.healthFactor === undefined
                ? undefined
                : toCanonical(input.lending.healthFactor),
            ltv:
              input.lending.ltv === undefined
                ? undefined
                : toCanonical(input.lending.ltv),
            liquidationThreshold:
              input.lending.liquidationThreshold === undefined
                ? undefined
                : toCanonical(input.lending.liquidationThreshold),
            totalCollateralUSD:
              input.lending.totalCollateralUSD === undefined
                ? undefined
                : toCanonical(input.lending.totalCollateralUSD),
            totalDebtUSD:
              input.lending.totalDebtUSD === undefined
                ? undefined
                : toCanonical(input.lending.totalDebtUSD),
          }
        : previous?.lending,
    });
  }

  private normalizeFundingFeeHistoryInput(
    input: FetchFundingFeeHistoryInput,
    metadata: FundingFeeFetchMetadata,
  ): NormalizedFundingFeeHistoryInput {
    const page = input.page ?? DEFAULT_FUNDING_FEE_HISTORY_PAGE;
    const limit = input.limit ?? DEFAULT_FUNDING_FEE_HISTORY_LIMIT;

    if (!Number.isSafeInteger(page) || page < 1) {
      throw this.createInputError("page must be a positive integer", metadata);
    }

    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw this.createInputError("limit must be a positive integer", metadata);
    }

    if (limit > MAX_FUNDING_FEE_HISTORY_LIMIT) {
      throw this.createInputError(
        `limit must be less than or equal to ${MAX_FUNDING_FEE_HISTORY_LIMIT} when fetching funding fee history`,
        metadata,
      );
    }

    if (
      input.startTs !== undefined &&
      (!Number.isSafeInteger(input.startTs) || input.startTs < 0)
    ) {
      throw this.createInputError(
        "startTs must be a non-negative epoch millisecond timestamp",
        metadata,
      );
    }

    if (
      input.endTs !== undefined &&
      (!Number.isSafeInteger(input.endTs) || input.endTs < 0)
    ) {
      throw this.createInputError(
        "endTs must be a non-negative epoch millisecond timestamp",
        metadata,
      );
    }

    if (
      input.startTs !== undefined &&
      input.endTs !== undefined &&
      input.startTs > input.endTs
    ) {
      throw this.createInputError(
        "startTs must be less than or equal to endTs when fetching funding fee history",
        metadata,
      );
    }

    const symbols =
      input.symbols === undefined
        ? undefined
        : this.normalizeFundingFeeSymbols(input.symbols, metadata);

    return {
      accountId: input.accountId,
      symbols,
      startTs: input.startTs,
      endTs: input.endTs,
      page,
      limit,
    };
  }

  private normalizeFundingFeeSymbols(
    symbols: string[],
    metadata: FundingFeeFetchMetadata,
  ): string[] {
    const unique: string[] = [];
    const seen = new Set<string>();

    for (const symbol of symbols) {
      if (symbol.trim() === "") {
        throw this.createInputError(
          "symbols cannot contain empty values when fetching funding fee history",
          metadata,
        );
      }

      if (!seen.has(symbol)) {
        seen.add(symbol);
        unique.push(symbol);
      }
    }

    return unique;
  }

  private async fetchPerSymbolFundingFeeHistory(
    input: NormalizedFundingFeeHistoryInput & { symbols: string[] },
    metadata: FundingFeeFetchMetadata,
  ): Promise<FetchFundingFeeHistoryResult> {
    const results = await Promise.all(
      input.symbols.map(async (symbol) => {
        try {
          const result = await this.context.fetchFundingFeeHistory({
            accountId: input.accountId,
            symbol,
            startTs: input.startTs,
            endTs: input.endTs,
            page: input.page,
            limit: input.limit,
          });
          return {
            fees: result.fees.map((fee) =>
              this.createFundingFeeHistoryEntry({ ...metadata, symbol }, fee),
            ),
            truncated: result.truncated,
          };
        } catch (error) {
          throw this.wrapFundingFeeHistoryFetchError(error, {
            ...metadata,
            symbol,
          });
        }
      }),
    );

    const fees = results.flatMap((result) => result.fees);
    const truncated = results.some((result) => result.truncated);
    return this.createFundingFeeHistoryResult(input, fees, truncated);
  }

  private async fetchAccountFundingFeeHistory(
    input: NormalizedFundingFeeHistoryInput,
    metadata: FundingFeeFetchMetadata,
  ): Promise<FetchFundingFeeHistoryResult> {
    try {
      const result = await this.context.fetchFundingFeeHistory({
        accountId: input.accountId,
        startTs: input.startTs,
        endTs: input.endTs,
        page: input.page,
        limit: input.limit,
      });
      const fees = result.fees.map((fee) =>
        this.createFundingFeeHistoryEntry(metadata, fee),
      );
      return this.createFundingFeeHistoryResult(input, fees, result.truncated);
    } catch (error) {
      throw this.wrapFundingFeeHistoryFetchError(error, metadata);
    }
  }

  private createFundingFeeHistoryResult(
    input: NormalizedFundingFeeHistoryInput,
    fees: FundingFeeHistoryEntry[],
    truncated: boolean,
  ): FetchFundingFeeHistoryResult {
    return {
      fees: fees.sort(compareFundingFeeHistoryEntries),
      startTs: input.startTs,
      endTs: input.endTs,
      page: input.page,
      limit: input.limit,
      truncated,
      nextPage: truncated ? input.page + 1 : undefined,
    };
  }

  private createFundingFeeHistoryEntry(
    metadata: FundingFeeFetchMetadata,
    input: RawFundingFeeHistoryEntry,
  ): FundingFeeHistoryEntry {
    return {
      accountId: metadata.accountId,
      venue: metadata.venue,
      symbol: input.symbol,
      asset: input.asset,
      amount: toCanonical(input.amount),
      fundingTime: input.fundingTime,
      receivedAt: input.receivedAt,
      venueTransactionId: input.venueTransactionId,
      tradeId: input.tradeId,
      positionSide: input.positionSide,
      raw: { ...input.raw },
    };
  }

  private createInputError(
    message: string,
    metadata: FundingFeeFetchMetadata,
  ): AcexError {
    return new AcexError("ACCOUNT_INPUT_INVALID", message, {
      details: buildAcexErrorDetails(metadata),
    });
  }

  private wrapFundingFeeHistoryFetchError(
    error: unknown,
    metadata: FundingFeeFetchMetadata,
  ): AcexError {
    if (error instanceof AcexError) {
      return error;
    }

    this.context.publishRuntimeError(
      "adapter",
      error instanceof Error
        ? error
        : new Error("Unknown funding fee history failure"),
      metadata,
    );
    const details = this.addVenueErrorReason(
      metadata.venue,
      buildAcexErrorDetails(metadata, error) ?? metadata,
    );
    return new AcexError(
      "ACCOUNT_FUNDING_FEE_HISTORY_FETCH_FAILED",
      formatAcexErrorMessage(
        `Failed to fetch funding fee history for ${metadata.accountId}`,
        details,
      ),
      {
        cause: error,
        details,
      },
    );
  }

  private addVenueErrorReason(
    venue: Venue,
    details: AcexErrorDetails,
  ): AcexErrorDetails {
    const venueErrorCode = details.venueError?.code;
    if (!venueErrorCode) {
      return details;
    }

    const reason = this.context.normalizeVenueErrorCode(venue, venueErrorCode);
    if (!reason) {
      return details;
    }

    return {
      ...details,
      venueError: {
        ...details.venueError,
        reason,
      },
    };
  }

  private publishStatus(record: AccountRecord): void {
    const event: AccountStatusChangedEvent = {
      type: "account.status_changed",
      accountId: record.accountId,
      venue: record.venue,
      status: cloneAccountStatus(record.status),
      ts: this.context.now(),
    };

    this.accountStatusBus.publish(event);
    this.context.publishHealthEvent(event);
  }

  private createOverflowHandler(
    stream: string,
  ): (info: AsyncEventBusOverflowInfo) => void {
    return ({ maxBuffer }) => {
      this.context.emitMetric(METRIC_NAMES.eventBufferOverflow, 1, "counter", {
        stream,
      });
      const error = new AcexError(
        "EVENT_BUFFER_OVERFLOW",
        `Event stream buffer overflow: ${stream}`,
      );
      this.context.publishRuntimeError("account", error, {
        stream,
        maxBuffer,
      });
    };
  }
}
