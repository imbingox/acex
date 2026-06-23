import { expect, test } from "bun:test";
import {
  createManagedWebSocket,
  DEFAULT_RECONNECT_JITTER_RATIO,
} from "../../src/internal/managed-websocket.ts";

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly sentFrames: string[] = [];
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

  send(data?: string): void {
    this.sentFrames.push(data ?? "");
  }

  emitJson(payload: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify(payload),
      }),
    );
  }

  emitRaw(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
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

  get timerCount(): number {
    return this.timers.size;
  }

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

test("managed websocket readyWhen open does not require an initial message after open", async () => {
  const clock = new FakeClock();
  const socket = new FakeWebSocket("wss://example.test/ws");
  const session = createManagedWebSocket<{ value?: string }>({
    url: socket.url,
    initialMessageTimeoutMs: 50,
    readyWhen: "open",
    parseMessage(data) {
      return JSON.parse(data) as { value?: string };
    },
    onMessage() {},
    onUnexpectedClose() {},
    createWebSocket() {
      return socket as unknown as WebSocket;
    },
    now: clock.now,
    setTimer: clock.setTimer as unknown as typeof setTimeout,
    clearTimer: clock.clearTimer as unknown as typeof clearTimeout,
  });

  await session.ready;
  clock.advance(50);

  expect(socket.readyState).toBe(FakeWebSocket.OPEN);
  expect(clock.timerCount).toBe(0);

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

test("managed websocket reconnect falls back to Math.random jitter when no RNG is injected", async () => {
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
    // Neither random nor jitterRatio injected: exercises the
    // `reconnect?.random ?? Math.random` fallback and DEFAULT_RECONNECT_JITTER_RATIO.
    reconnect: {
      initialDelayMs: 100,
      maxDelayMs: 1_000,
    },
    now: clock.now,
    setTimer: clock.setTimer as unknown as typeof setTimeout,
    clearTimer: clock.clearTimer as unknown as typeof clearTimeout,
  });

  sockets[0]?.emitJson({ value: "ready" });
  await session.ready;
  sockets[0]?.disconnect();

  // base = 100, jitter = ±DEFAULT_RECONNECT_JITTER_RATIO of base, so the delay
  // is in [80, 120] for ANY Math.random() value — the bracket below holds
  // deterministically (no flakiness despite the real RNG).
  const lowerBound = Math.round(100 * (1 - DEFAULT_RECONNECT_JITTER_RATIO));
  const upperBound = Math.round(100 * (1 + DEFAULT_RECONNECT_JITTER_RATIO));

  expect(sockets).toHaveLength(1);
  clock.advance(lowerBound - 1);
  expect(sockets).toHaveLength(1);
  clock.advance(upperBound - (lowerBound - 1));
  expect(sockets).toHaveLength(2);

  session.close();
});

test("managed websocket pong does not satisfy readyWhen message initial timeout", async () => {
  const clock = new FakeClock();
  const socket = new FakeWebSocket("wss://example.test/ws");
  const errors: Event[] = [];
  const messages: { value: string }[] = [];

  const session = createManagedWebSocket<{ value: string }>({
    url: socket.url,
    initialMessageTimeoutMs: 50,
    readyWhen: "message",
    parseMessage(data) {
      return JSON.parse(data) as { value: string };
    },
    onMessage(message) {
      messages.push(message);
    },
    onUnexpectedClose() {},
    onError(event) {
      errors.push(event);
    },
    heartbeat: {
      intervalMs: 10,
      mode: "fixed-interval",
      pongTimeoutMs: 30,
      frame: () => "ping",
      isPong: (raw) => raw === "pong",
    },
    createWebSocket() {
      return socket as unknown as WebSocket;
    },
    now: clock.now,
    setTimer: clock.setTimer as unknown as typeof setTimeout,
    clearTimer: clock.clearTimer as unknown as typeof clearTimeout,
  });

  await Promise.resolve();
  clock.advance(10);
  expect(socket.sentFrames).toEqual(["ping"]);

  socket.emitRaw("pong");
  clock.advance(39);
  expect(socket.readyState).toBe(FakeWebSocket.OPEN);

  clock.advance(1);
  await expect(session.ready).rejects.toThrow(
    "Timed out waiting for the first websocket message",
  );

  expect(messages).toHaveLength(0);
  expect(errors).toHaveLength(0);
  expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  expect(clock.timerCount).toBe(0);
});

test("managed websocket idle heartbeat does not reschedule timers per inbound message", async () => {
  const clock = new FakeClock();
  let setTimerCalls = 0;
  const countingSetTimer: typeof clock.setTimer = (
    handler,
    timeout,
    ...args
  ) => {
    setTimerCalls += 1;
    return clock.setTimer(handler, timeout, ...args);
  };
  const socket = new FakeWebSocket("wss://example.test/ws");
  const session = createManagedWebSocket<{ value?: string }>({
    url: socket.url,
    initialMessageTimeoutMs: 1_000,
    parseMessage(data) {
      return JSON.parse(data) as { value?: string };
    },
    onMessage() {},
    onUnexpectedClose() {},
    createWebSocket() {
      return socket as unknown as WebSocket;
    },
    heartbeat: {
      intervalMs: 100,
      mode: "idle-timeout",
      frame: () => "ping",
      isPong: (raw) => raw === "pong",
    },
    now: clock.now,
    setTimer: countingSetTimer as unknown as typeof setTimeout,
    clearTimer: clock.clearTimer as unknown as typeof clearTimeout,
  });

  socket.emitJson({ value: "ready" });
  await session.ready;

  const baseline = setTimerCalls;
  for (let i = 0; i < 100; i += 1) {
    clock.advance(1);
    socket.emitJson({ value: `tick-${i}` });
  }

  // Sustained inbound traffic only stamps the activity time; the idle timer
  // re-sleeps lazily instead of being cleared and recreated per message.
  expect(setTimerCalls - baseline).toBeLessThanOrEqual(2);
  expect(socket.sentFrames).toHaveLength(0);

  clock.advance(100);
  expect(socket.sentFrames).toEqual(["ping"]);

  session.close();
});
