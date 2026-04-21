import type { AcexInternalError } from "../index.ts";

const SOCKET_POLL_INTERVAL_MS = 25;
const STATE_POLL_INTERVAL_MS = 50;
const originalWebSocket = globalThis.WebSocket;
const NativeWebSocket = originalWebSocket;

export interface ErrorSummary {
  source: AcexInternalError["source"];
  exchange?: string;
  symbol?: string;
  accountId?: string;
  message: string;
  ts: number;
}

export function writeStdout(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function parseNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid value for ${flag}: ${value}`);
  }
  return parsed;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function sleep(ms: number): Promise<void> {
  return Bun.sleep(ms);
}

export async function nextEvent<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const result = (await Promise.race([
    iterator.next(),
    sleep(timeoutMs).then(() => {
      throw new Error(label);
    }),
  ])) as IteratorResult<T>;

  if (result.done) {
    throw new Error(`${label}: stream closed`);
  }

  return result.value;
}

export async function waitForCondition<T>(
  check: () => T | undefined,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const current = check();
    if (current !== undefined) {
      return current;
    }

    await sleep(STATE_POLL_INTERVAL_MS);
  }

  throw new Error(label);
}

export class TrackedWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static readonly instances: TrackedWebSocket[] = [];

  readonly url: string;
  readonly createdAt = Date.now();

  private readonly socket: WebSocket;

  constructor(url: string, protocols?: string | string[]) {
    super();
    this.url = url;
    this.socket =
      protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols);

    TrackedWebSocket.instances.push(this);

    this.socket.addEventListener("open", () => {
      this.dispatchEvent(new Event("open"));
    });

    this.socket.addEventListener("message", (event) => {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: event.data,
        }),
      );
    });

    this.socket.addEventListener("error", () => {
      this.dispatchEvent(new Event("error"));
    });

    this.socket.addEventListener("close", (event) => {
      this.dispatchEvent(
        new CloseEvent("close", {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        }),
      );
    });
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  send(
    data: string | ArrayBufferLike | Bun.ArrayBufferView<ArrayBufferLike>,
  ): void {
    this.socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  forceClose(reason = "script disconnect"): void {
    this.socket.close(1000, reason);
  }
}

export function installTrackedWebSocket(): void {
  TrackedWebSocket.instances.length = 0;
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: TrackedWebSocket as unknown as typeof WebSocket,
  });
}

export function restoreTrackedWebSocket(): void {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: originalWebSocket,
  });
  TrackedWebSocket.instances.length = 0;
}

export function summarizeError(error: AcexInternalError): ErrorSummary {
  return {
    source: error.source,
    exchange: error.exchange,
    symbol: error.symbol,
    accountId: error.accountId,
    message: error.error.message,
    ts: error.ts,
  };
}

export function cloneStatus(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export async function waitForTrackedSocket(
  index: number,
  timeoutMs: number,
  label: string,
): Promise<TrackedWebSocket> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const socket = TrackedWebSocket.instances[index];
    if (socket) {
      return socket;
    }

    await sleep(SOCKET_POLL_INTERVAL_MS);
  }

  throw new Error(label);
}

export async function collectEventsUntil<T>(
  iterator: AsyncIterator<T>,
  deadlineMs: number,
  options?: {
    doneLabel?: string;
    idlePollMs?: number;
    onEvent?: (event: T) => void;
  },
): Promise<number> {
  let count = 0;

  while (Date.now() < deadlineMs) {
    const remainingMs = Math.max(deadlineMs - Date.now(), 0);
    const result = await Promise.race([
      iterator.next(),
      sleep(Math.min(remainingMs, options?.idlePollMs ?? 1_000)).then(
        () => undefined,
      ),
    ]);

    if (!result) {
      continue;
    }

    if (result.done) {
      throw new Error(
        options?.doneLabel ?? "Update stream closed unexpectedly",
      );
    }

    options?.onEvent?.(result.value);
    count += 1;
  }

  return count;
}
