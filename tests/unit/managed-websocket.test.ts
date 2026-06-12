import { expect, test } from "bun:test";
import { createManagedWebSocket } from "../../src/internal/managed-websocket.ts";

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;

  constructor(readonly url: string) {
    super();
    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) {
        return;
      }

      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(): void {}

  emitJson(payload: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify(payload),
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
}

class FakeClock {
  private current = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; run(): void }>();

  readonly now = (): number => this.current;

  readonly setTimer = (
    handler: Parameters<typeof setTimeout>[0],
    timeout?: Parameters<typeof setTimeout>[1],
    ...args: unknown[]
  ): ReturnType<typeof setTimeout> => {
    const id = this.nextId;
    this.nextId += 1;
    const callback =
      typeof handler === "function"
        ? (): void => {
            handler(...args);
          }
        : (): void => {
            throw new Error("String timer handlers are not supported in tests");
          };

    this.timers.set(id, {
      at: this.current + (timeout ?? 0),
      run: callback,
    });

    return id as unknown as ReturnType<typeof setTimeout>;
  };

  readonly clearTimer = (handle: Parameters<typeof clearTimeout>[0]): void => {
    this.timers.delete(handle as unknown as number);
  };

  advance(ms: number): void {
    const target = this.current + ms;

    while (true) {
      let nextId: number | undefined;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < nextAt) {
          nextId = id;
          nextAt = timer.at;
        }
      }

      if (nextId === undefined) {
        break;
      }

      const timer = this.timers.get(nextId);
      if (!timer) {
        continue;
      }

      this.timers.delete(nextId);
      this.current = timer.at;
      timer.run();
    }

    this.current = target;
  }
}

async function expectReconnectDelay(options: {
  readonly random: () => number;
  readonly maxDelayMs: number;
  readonly expectedDelayMs: number;
}): Promise<void> {
  const clock = new FakeClock();
  const sockets: FakeWebSocket[] = [];
  const session = createManagedWebSocket<{ value: string }>({
    url: "wss://example.test/ws",
    initialMessageTimeoutMs: 1_000,
    parseMessage(data) {
      return JSON.parse(data) as { value: string };
    },
    onMessage() {},
    onUnexpectedClose() {},
    createWebSocket(url) {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    reconnect: {
      initialDelayMs: 100,
      maxDelayMs: options.maxDelayMs,
      random: options.random,
    },
    now: clock.now,
    setTimer: clock.setTimer as unknown as typeof setTimeout,
    clearTimer: clock.clearTimer as unknown as typeof clearTimeout,
  });

  sockets[0]?.emitJson({ value: "ready" });
  await session.ready;
  sockets[0]?.disconnect();

  expect(sockets).toHaveLength(1);
  clock.advance(options.expectedDelayMs - 1);
  expect(sockets).toHaveLength(1);
  clock.advance(1);
  expect(sockets).toHaveLength(2);

  session.close();
}

test("managed websocket can run without a message watchdog", async () => {
  const socket = new FakeWebSocket("wss://example.test/ws");

  const session = createManagedWebSocket<{ value?: string }>({
    url: socket.url,
    initialMessageTimeoutMs: 50,
    parseMessage(data) {
      return JSON.parse(data) as { value?: string };
    },
    onMessage() {},
    onUnexpectedClose() {},
    createWebSocket() {
      return socket as unknown as WebSocket;
    },
    messageWatchdog: undefined,
    onError(event) {
      throw new Error(`Unexpected websocket error: ${event.type}`);
    },
  });

  socket.emitJson({ value: "ready" });
  await session.ready;
  await Bun.sleep(30);

  expect(socket.readyState).toBe(FakeWebSocket.OPEN);

  session.close();
});

test("managed websocket reconnect backoff applies deterministic jitter and clamps to max delay", async () => {
  await expectReconnectDelay({
    random: () => 0,
    maxDelayMs: 1_000,
    expectedDelayMs: 80,
  });
  await expectReconnectDelay({
    random: () => 0.5,
    maxDelayMs: 1_000,
    expectedDelayMs: 100,
  });
  await expectReconnectDelay({
    random: () => 1,
    maxDelayMs: 110,
    expectedDelayMs: 110,
  });
});
