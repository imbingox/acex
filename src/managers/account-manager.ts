import type {
  AccountAwareManager,
  ClientContext,
  HealthReporter,
  ManagerLifecycle,
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

export class AccountManagerImpl
  implements
    AccountManager,
    ManagerLifecycle,
    AccountAwareManager,
    HealthReporter<AccountDataStatus>
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
    record.snapshot ??= this.createEmptySnapshot(
      input.accountId,
      account.exchange,
    );
    record.status = {
      ...this.createStatus(input.accountId, account.exchange, "active"),
      ready: true,
      runtimeStatus: "healthy",
      lastReceivedAt: record.snapshot.updatedAt,
      lastReadyAt: record.snapshot.updatedAt,
    };

    const event: AccountSnapshotReplacedEvent = {
      type: "account.snapshot_replaced",
      accountId: record.accountId,
      exchange: record.exchange,
      snapshot: record.snapshot,
      ts: this.context.now(),
    };

    this.accountBus.publish(event);
    this.publishStatus(record);
  }

  async unsubscribeAccount(input: UnsubscribeAccountInput): Promise<void> {
    const record = this.records.get(input.accountId);
    if (!record?.subscribed) {
      return;
    }

    record.subscribed = false;
    record.status = {
      ...record.status,
      activity: "inactive",
      runtimeStatus: "stopped",
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

  onClientStarted(): void {
    const now = this.context.now();

    for (const [accountId, record] of this.records) {
      if (!record.subscribed) {
        continue;
      }

      const account = this.context.getRegisteredAccount(accountId);
      const creds = account.credentials;
      if (!creds?.apiKey || !creds.secret) {
        continue;
      }

      record.snapshot ??= this.createEmptySnapshot(accountId, account.exchange);
      record.status = {
        ...this.createStatus(accountId, account.exchange, "active"),
        ready: true,
        runtimeStatus: "healthy",
        lastReceivedAt: now,
        lastReadyAt: record.snapshot.updatedAt,
      };
      this.publishStatus(record);
    }
  }

  onClientStopping(now: number): void {
    for (const record of this.records.values()) {
      if (!record.subscribed) {
        continue;
      }

      record.status = {
        ...record.status,
        activity: "inactive",
        runtimeStatus: "stopped",
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

    record.status = this.createStatus(accountId, exchange, "active");
    record.status.ready = Boolean(record.snapshot);
    record.status.runtimeStatus = "healthy";
    record.status.lastReadyAt =
      record.snapshot?.updatedAt ?? this.context.now();
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
