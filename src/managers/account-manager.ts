import {
  cloneAccountStatus,
} from "../client/records.ts";
import type { AcexClientImpl } from "../client/runtime.ts";
import type {
  AccountDataStatus,
  AccountEventStreams,
  AccountManager,
  AccountSnapshot,
  AccountSnapshotReplacedEvent,
  BalanceSnapshot,
  PositionKeyInput,
  PositionSnapshot,
  RiskSnapshot,
  SubscribeAccountInput,
  UnsubscribeAccountInput,
} from "../types/index.ts";

export class AccountManagerImpl implements AccountManager {
  readonly events: AccountEventStreams;

  constructor(private readonly client: AcexClientImpl) {
    this.events = client.accountEvents();
  }

  async subscribeAccount(input: SubscribeAccountInput): Promise<void> {
    this.client.assertStarted();
    const account = this.client.getRegisteredAccount(input.accountId);
    this.client.ensurePrivateCredentials(input.accountId);

    const record = this.client.getOrCreateAccountRecord(input.accountId, account.exchange);
    record.subscribed = true;
    record.snapshot ??= this.client.createEmptyAccountSnapshot(input.accountId, account.exchange);
    record.status = {
      ...this.client.createAccountStatus(input.accountId, account.exchange, "active"),
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
      ts: this.client.now(),
    };

    this.client.publishAccountEvent(event);
    this.client.publishAccountStatus(record);
  }

  async unsubscribeAccount(input: UnsubscribeAccountInput): Promise<void> {
    const record = this.client.getAccountRecord(input.accountId);
    if (!record || !record.subscribed) {
      return;
    }

    record.subscribed = false;
    record.status = {
      ...record.status,
      activity: "inactive",
      runtimeStatus: "stopped",
      inactiveSince: this.client.now(),
    };
    this.client.publishAccountStatus(record);
  }

  getAccountSnapshot(accountId: string): AccountSnapshot | undefined {
    return this.client.getAccountRecord(accountId)?.snapshot;
  }

  getBalance(accountId: string, asset: string): BalanceSnapshot | undefined {
    return this.client.getAccountRecord(accountId)?.snapshot?.balances[asset];
  }

  getBalances(accountId: string): BalanceSnapshot[] {
    const balances = this.client.getAccountRecord(accountId)?.snapshot?.balances;
    return balances ? Object.values(balances) : [];
  }

  getPosition(input: PositionKeyInput): PositionSnapshot | undefined {
    return this.getPositions(input.accountId, input.symbol).find(
      (position) => input.side === undefined || position.side === input.side,
    );
  }

  getPositions(accountId: string, symbol?: string): PositionSnapshot[] {
    const positions = this.client.getAccountRecord(accountId)?.snapshot?.positions ?? [];
    if (!symbol) {
      return [...positions];
    }
    return positions.filter((position) => position.symbol === symbol);
  }

  getRiskSnapshot(accountId: string): RiskSnapshot | undefined {
    return this.client.getAccountRecord(accountId)?.snapshot?.risk;
  }

  getAccountStatus(accountId: string): AccountDataStatus | undefined {
    const status = this.client.getAccountRecord(accountId)?.status;
    return status ? cloneAccountStatus(status) : undefined;
  }
}
