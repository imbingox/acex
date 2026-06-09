import BigNumber from "bignumber.js";
import type {
  RawAccountBootstrap,
  RawAccountUpdate,
  RawBalanceUpdate,
  RawPositionUpdate,
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
  PositionKeyInput,
  PositionSnapshot,
  RiskSnapshot,
  SubscribeAccountInput,
  UnsubscribeAccountInput,
  Venue,
} from "../types/index.ts";

interface AccountRecord {
  accountId: string;
  venue: Venue;
  subscribed: boolean;
  snapshot?: AccountSnapshot;
  status: AccountDataStatus;
}

function cloneAccountStatus(status: AccountDataStatus): AccountDataStatus {
  return { ...status };
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

function isZeroBalance(balance: BalanceSnapshot): boolean {
  return (
    isZeroDecimal(balance.free) &&
    isZeroDecimal(balance.used) &&
    isZeroDecimal(balance.total)
  );
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

  return {
    ...status,
    activity: "active",
    ready: options.ready ?? true,
    runtimeStatus: preservesStreamState ? status.runtimeStatus : "healthy",
    reason: preservesStreamState ? status.reason : undefined,
    lastReceivedAt: options.lastReceivedAt ?? status.lastReceivedAt,
    lastReadyAt: options.preserveStatus
      ? (status.lastReadyAt ?? options.lastReadyAt)
      : (options.lastReadyAt ?? status.lastReadyAt),
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
      status: (filter) =>
        this.accountStatusBus.stream((event) =>
          matchesAccountFilter(
            { accountId: event.accountId, venue: event.venue },
            filter,
          ),
        ),
      updates: (filter) =>
        this.accountBus.stream((event) =>
          matchesAccountFilter(
            {
              accountId: event.accountId,
              venue: event.venue,
              symbol: "symbol" in event ? event.symbol : undefined,
            },
            filter,
          ),
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
      if (
        !shouldApplyWatermarkedUpdate(positions.get(key), position, {
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
        positions.get(key),
      );

      if (isZeroDecimal(nextPosition.size)) {
        positions.delete(key);
      } else {
        positions.set(key, nextPosition);
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

    if (
      update.risk &&
      shouldApplyWatermarkedUpdate(previous.risk, update.risk, {
        requestStartedAt: options.requestStartedAt,
        source: options.requestStartedAt === undefined ? "stream" : "rest",
      })
    ) {
      risk = this.createRisk(accountId, venue, update.risk, previous.risk);
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

    record.snapshot = {
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
    };
    record.status = successfulStatus(record.status, {
      preserveStatus: options.preserveStatus,
      lastReceivedAt: latestAppliedAt,
      lastReadyAt: latestAppliedAt,
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

    record.snapshot = {
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
    };
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

    return {
      accountId,
      venue,
      balances,
      positions,
      risk,
      exchangeTs: bootstrap.exchangeTs,
      receivedAt: bootstrap.receivedAt,
      updatedAt: bootstrap.receivedAt,
    };
  }

  private createEmptySnapshot(
    accountId: string,
    venue: Venue,
  ): AccountSnapshot {
    const now = this.context.now();
    return {
      accountId,
      venue,
      balances: {},
      positions: [],
      receivedAt: now,
      updatedAt: now,
    };
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

    return {
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
            supplied: toCanonical(input.lending.supplied),
            borrowed: toCanonical(input.lending.borrowed),
            interest: toCanonical(input.lending.interest),
            netAsset: toCanonical(input.lending.netAsset),
            supplyAPY:
              input.lending.supplyAPY === undefined
                ? undefined
                : toCanonical(input.lending.supplyAPY),
            borrowAPY:
              input.lending.borrowAPY === undefined
                ? undefined
                : toCanonical(input.lending.borrowAPY),
          }
        : previous?.lending,
    };
  }

  private createPosition(
    accountId: string,
    venue: Venue,
    input: RawPositionUpdate,
    previous?: PositionSnapshot,
  ): PositionSnapshot {
    return {
      accountId,
      venue,
      symbol: input.symbol,
      side: input.side,
      size: toCanonical(input.size),
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
    };
  }

  private createRisk(
    accountId: string,
    venue: Venue,
    input: RawRiskUpdate,
    previous?: RiskSnapshot,
  ): RiskSnapshot {
    return {
      accountId,
      venue,
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
}
