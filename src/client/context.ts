import type {
  AccountCredentials,
  AcexInternalError,
  Exchange,
  HealthEvent,
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
