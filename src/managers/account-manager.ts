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
import { matchesAccountFilter } from "../internal/filters.ts";
import type {
  AccountDataStatus,
  AccountEvent,
  AccountEventStreams,
  AccountManager,
  AccountSnapshot,
  AccountSnapshotReplacedEvent,
  AccountStatusChangedEvent,
  BalanceSnapshot,
  Exchange,
  PositionKeyInput,
  PositionSnapshot,
  RiskSnapshot,
  SubscribeAccountInput,
  UnsubscribeAccountInput,
} from "../types/index.ts";

interface AccountRecord {
  accountId: string;
  exchange: Exchange;
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
            { accountId: event.accountId, exchange: event.exchange },
            filter,
          ),
        ),
      updates: (filter) =>
        this.accountBus.stream((event) =>
          matchesAccountFilter(
            {
              accountId: event.accountId,
              exchange: event.exchange,
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

    const record = this.getOrCreateRecord(input.accountId, account.exchange);
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

  onCredentialsUpdated(accountId: string, exchange: Exchange): void {
    const record = this.records.get(accountId);
    if (!record?.subscribed) {
      return;
    }

    this.onPrivateAccountPending(accountId, exchange);
  }

  // --- PrivateAccountDataConsumer ---

  onPrivateAccountPending(accountId: string, exchange: Exchange): void {
    const record = this.getOrCreateRecord(accountId, exchange);
    if (!record.subscribed) {
      return;
    }

    record.status = {
      ...this.createStatus(accountId, exchange, "active"),
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
    exchange: Exchange,
    bootstrap: RawAccountBootstrap,
  ): void {
    const record = this.getOrCreateRecord(accountId, exchange);
    if (!record.subscribed) {
      return;
    }

    record.snapshot = this.createBootstrapSnapshot(
      accountId,
      exchange,
      bootstrap,
    );
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
      exchange,
      snapshot: record.snapshot,
      ts: this.context.now(),
    };

    this.accountBus.publish(event);
    this.publishStatus(record);
  }

  onPrivateAccountUpdate(
    accountId: string,
    exchange: Exchange,
    update: RawAccountUpdate,
  ): void {
    const record = this.getOrCreateRecord(accountId, exchange);
    if (!record.subscribed) {
      return;
    }

    const previous =
      record.snapshot ?? this.createEmptySnapshot(accountId, exchange);
    const balances = { ...previous.balances };
    const positions = new Map(
      previous.positions.map((position) => [
        positionKey(position.symbol, position.side),
        position,
      ]),
    );
    let risk = previous.risk;

    for (const balance of update.balances ?? []) {
      const nextBalance = this.createBalance(
        accountId,
        exchange,
        balance,
        balances[balance.asset],
      );
      balances[balance.asset] = nextBalance;
      this.accountBus.publish({
        type: "balance.updated",
        accountId,
        exchange,
        asset: balance.asset,
        snapshot: nextBalance,
        ts: this.context.now(),
      });
    }

    for (const position of update.positions ?? []) {
      const key = positionKey(position.symbol, position.side);
      const nextPosition = this.createPosition(
        accountId,
        exchange,
        position,
        positions.get(key),
      );

      if (nextPosition.size.isZero()) {
        positions.delete(key);
      } else {
        positions.set(key, nextPosition);
      }

      this.accountBus.publish({
        type: "position.updated",
        accountId,
        exchange,
        symbol: position.symbol,
        snapshot: nextPosition,
        ts: this.context.now(),
      });
    }

    if (update.risk) {
      risk = this.createRisk(accountId, exchange, update.risk, previous.risk);
      this.accountBus.publish({
        type: "risk.updated",
        accountId,
        exchange,
        snapshot: risk,
        ts: this.context.now(),
      });
    }

    record.snapshot = {
      accountId,
      exchange,
      balances,
      positions: [...positions.values()],
      risk,
      exchangeTs: update.exchangeTs ?? previous.exchangeTs,
      receivedAt: update.receivedAt,
      updatedAt: update.receivedAt,
    };
    record.status = {
      ...record.status,
      activity: "active",
      ready: true,
      runtimeStatus: "healthy",
      reason: undefined,
      lastReceivedAt: update.receivedAt,
      lastReadyAt: update.receivedAt,
      inactiveSince: undefined,
    };
    this.publishStatus(record);
  }

  onPrivateAccountStreamState(
    accountId: string,
    exchange: Exchange,
    state: PrivateSubscriptionState,
  ): void {
    const record = this.getOrCreateRecord(accountId, exchange);
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
        `${left.exchange}:${left.accountId}`.localeCompare(
          `${right.exchange}:${right.accountId}`,
        ),
      );
  }

  // --- Internal helpers ---

  private getOrCreateRecord(
    accountId: string,
    exchange: Exchange,
  ): AccountRecord {
    const existing = this.records.get(accountId);
    if (existing) {
      return existing;
    }

    const record: AccountRecord = {
      accountId,
      exchange,
      subscribed: false,
      status: this.createStatus(accountId, exchange, "inactive"),
    };

    this.records.set(accountId, record);
    return record;
  }

  private createStatus(
    accountId: string,
    exchange: Exchange,
    activity: "active" | "inactive",
  ): AccountDataStatus {
    return {
      accountId,
      exchange,
      activity,
      ready: false,
      runtimeStatus: activity === "active" ? "bootstrap_pending" : "stopped",
    };
  }

  private createBootstrapSnapshot(
    accountId: string,
    exchange: Exchange,
    bootstrap: RawAccountBootstrap,
  ): AccountSnapshot {
    const balances = Object.fromEntries(
      bootstrap.balances.map((balance) => [
        balance.asset,
        this.createBalance(accountId, exchange, balance),
      ]),
    );
    const positions = bootstrap.positions
      .map((position) => this.createPosition(accountId, exchange, position))
      .filter((position) => !position.size.isZero());
    const risk = bootstrap.risk
      ? this.createRisk(accountId, exchange, bootstrap.risk)
      : undefined;

    return {
      accountId,
      exchange,
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
    exchange: Exchange,
  ): AccountSnapshot {
    const now = this.context.now();
    return {
      accountId,
      exchange,
      balances: {},
      positions: [],
      receivedAt: now,
      updatedAt: now,
    };
  }

  private createBalance(
    accountId: string,
    exchange: Exchange,
    input: RawBalanceUpdate,
    previous?: BalanceSnapshot,
  ): BalanceSnapshot {
    const previousFree = previous?.free ?? new BigNumber(0);
    const previousUsed = previous?.used ?? new BigNumber(0);
    const previousTotal = previous?.total ?? previousFree.plus(previousUsed);
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
      exchange,
      asset: input.asset,
      free,
      used,
      total,
      exchangeTs: input.exchangeTs,
      receivedAt: input.receivedAt,
      updatedAt: input.receivedAt,
      seq: (previous?.seq ?? 0) + 1,
    };
  }

  private createPosition(
    accountId: string,
    exchange: Exchange,
    input: RawPositionUpdate,
    previous?: PositionSnapshot,
  ): PositionSnapshot {
    return {
      accountId,
      exchange,
      symbol: input.symbol,
      side: input.side,
      size: new BigNumber(input.size),
      entryPrice:
        input.entryPrice === undefined
          ? previous?.entryPrice
          : new BigNumber(input.entryPrice),
      markPrice:
        input.markPrice === undefined
          ? previous?.markPrice
          : new BigNumber(input.markPrice),
      unrealizedPnl:
        input.unrealizedPnl === undefined
          ? previous?.unrealizedPnl
          : new BigNumber(input.unrealizedPnl),
      leverage:
        input.leverage === undefined
          ? previous?.leverage
          : new BigNumber(input.leverage),
      liquidationPrice:
        input.liquidationPrice === undefined
          ? previous?.liquidationPrice
          : new BigNumber(input.liquidationPrice),
      exchangeTs: input.exchangeTs,
      receivedAt: input.receivedAt,
      updatedAt: input.receivedAt,
      seq: (previous?.seq ?? 0) + 1,
    };
  }

  private createRisk(
    accountId: string,
    exchange: Exchange,
    input: RawRiskUpdate,
    previous?: RiskSnapshot,
  ): RiskSnapshot {
    return {
      accountId,
      exchange,
      equity:
        input.equity === undefined
          ? previous?.equity
          : new BigNumber(input.equity),
      marginRatio:
        input.marginRatio === undefined
          ? previous?.marginRatio
          : new BigNumber(input.marginRatio),
      initialMargin:
        input.initialMargin === undefined
          ? previous?.initialMargin
          : new BigNumber(input.initialMargin),
      maintenanceMargin:
        input.maintenanceMargin === undefined
          ? previous?.maintenanceMargin
          : new BigNumber(input.maintenanceMargin),
      exchangeTs: input.exchangeTs,
      receivedAt: input.receivedAt,
      updatedAt: input.receivedAt,
      seq: (previous?.seq ?? 0) + 1,
    };
  }

  private publishStatus(record: AccountRecord): void {
    const event: AccountStatusChangedEvent = {
      type: "account.status_changed",
      accountId: record.accountId,
      exchange: record.exchange,
      status: cloneAccountStatus(record.status),
      ts: this.context.now(),
    };

    this.accountStatusBus.publish(event);
    this.context.publishHealthEvent(event);
  }
}
