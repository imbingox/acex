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
  HealthEvent,
  PrivateRuntimeReason,
  PrivateRuntimeStatus,
  Venue,
} from "../types/index.ts";

export interface RegisteredAccountRecord {
  accountId: string;
  venue: Venue;
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
    options?: { preserveStatus?: boolean },
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
    snapshots: RawOrderUpdate[],
  ): void;
  onPrivateOrderUpdate(
    accountId: string,
    venue: Venue,
    update: RawOrderUpdate,
  ): void;
  onPrivateOrderStreamState(
    accountId: string,
    venue: Venue,
    state: PrivateSubscriptionState,
  ): void;
}

export function hasPrivateCredentials(
  credentials?: AccountCredentials,
  venue?: Venue,
): boolean {
  if (venue === "juplend") {
    return Boolean(credentials?.apiKey);
  }

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
