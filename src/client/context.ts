import type {
  RawAccountBootstrap,
  RawAccountUpdate,
  RawOrderUpdate,
} from "../adapters/types.ts";
import type {
  AccountCredentials,
  AcexInternalError,
  CancelAllOrdersInput,
  CancelOrderInput,
  CreateOrderInput,
  Exchange,
  HealthEvent,
  PrivateRuntimeReason,
  PrivateRuntimeStatus,
} from "../types/index.ts";

export interface RegisteredAccountRecord {
  accountId: string;
  exchange: Exchange;
  credentials?: AccountCredentials;
  options?: Record<string, unknown>;
}

export interface ClientContext {
  now(): number;
  assertStarted(): void;
  getRegisteredAccount(accountId: string): RegisteredAccountRecord;
  ensurePrivateCredentials(accountId: string): void;
  subscribePrivateAccountFeed(accountId: string): Promise<void>;
  unsubscribePrivateAccountFeed(accountId: string): void;
  subscribePrivateOrderFeed(accountId: string): Promise<void>;
  unsubscribePrivateOrderFeed(accountId: string): void;
  createOrder(input: CreateOrderInput): Promise<RawOrderUpdate>;
  cancelOrder(input: CancelOrderInput): Promise<RawOrderUpdate>;
  cancelAllOrders(input: CancelAllOrdersInput): Promise<RawOrderUpdate[]>;
  publishRuntimeError(
    source: AcexInternalError["source"],
    error: Error,
    metadata?: Omit<AcexInternalError, "error" | "source" | "ts">,
  ): void;
  publishHealthEvent(event: HealthEvent): void;
}

export interface ManagerLifecycle {
  onClientStarted(): void;
  onClientStopping(now: number): void;
}

export interface AccountAwareManager {
  onAccountRemoved(accountId: string, now: number): void;
  onCredentialsUpdated(accountId: string, exchange: Exchange): void;
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

export interface PrivateAccountDataConsumer {
  onPrivateAccountPending(accountId: string, exchange: Exchange): void;
  onPrivateAccountBootstrap(
    accountId: string,
    exchange: Exchange,
    bootstrap: RawAccountBootstrap,
  ): void;
  onPrivateAccountUpdate(
    accountId: string,
    exchange: Exchange,
    update: RawAccountUpdate,
  ): void;
  onPrivateAccountStreamState(
    accountId: string,
    exchange: Exchange,
    state: PrivateSubscriptionState,
  ): void;
}

export interface PrivateOrderDataConsumer {
  onPrivateOrderPending(accountId: string, exchange: Exchange): void;
  onPrivateOrderBootstrap(
    accountId: string,
    exchange: Exchange,
    snapshots: RawOrderUpdate[],
  ): void;
  onPrivateOrderUpdate(
    accountId: string,
    exchange: Exchange,
    update: RawOrderUpdate,
  ): void;
  onPrivateOrderStreamState(
    accountId: string,
    exchange: Exchange,
    state: PrivateSubscriptionState,
  ): void;
}

export function hasPrivateCredentials(
  credentials?: AccountCredentials,
): boolean {
  return Boolean(credentials?.apiKey && credentials.secret);
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
