import { afterEach } from "bun:test";
import { stopAllClientsForTests } from "../../src/client/runtime.ts";

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

export function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

export function textResponse(
  body: string,
  options: { status: number; statusText: string },
): Response {
  return new Response(body, options);
}

export class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) {
        return;
      }

      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  send(): void {}

  emitJson(payload: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify(payload),
      }),
    );
  }

  disconnect(code = 1006, reason = "network down"): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(
      new CloseEvent("close", {
        code,
        reason,
        wasClean: false,
      }),
    );
  }

  close(code = 1000, reason = "manual close"): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(
      new CloseEvent("close", {
        code,
        reason,
        wasClean: true,
      }),
    );
  }
}

export async function waitForSocket(
  url: string,
  instanceIndex = 0,
  timeoutMs = 100,
): Promise<FakeWebSocket> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const matches = FakeWebSocket.instances.filter(
      (instance) => instance.url === url,
    );
    const socket = matches[instanceIndex];
    if (socket) {
      return socket;
    }

    await Bun.sleep(1);
  }

  throw new Error(`Timed out waiting for FakeWebSocket ${url}`);
}

export async function nextEvent<T>(
  iterator: AsyncIterator<T>,
  timeoutMs = 1000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = (await Promise.race([
    iterator.next().then((value) => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }

      return value;
    }),
    new Promise<IteratorResult<T>>((_, reject) => {
      timeout = setTimeout(() => {
        timeout = undefined;
        reject(new Error("Timed out waiting for event"));
      }, timeoutMs);
    }),
  ])) as IteratorResult<T>;

  if (result.done) {
    throw new Error("Event stream closed unexpectedly");
  }

  return result.value;
}

export async function expectPending<T>(
  promise: Promise<T>,
  timeoutMs = 25,
): Promise<void> {
  const result = await Promise.race([
    promise.then(() => "resolved" as const),
    Bun.sleep(timeoutMs).then(() => "pending" as const),
  ]);

  if (result !== "pending") {
    throw new Error(`Expected promise to stay pending for ${timeoutMs}ms`);
  }
}

afterEach(() => {
  stopAllClientsForTests();
  FakeWebSocket.reset();
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: originalFetch,
  });
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: originalWebSocket,
  });
});
