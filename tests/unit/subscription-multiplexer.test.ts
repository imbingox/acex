import { beforeEach, expect, test } from "bun:test";
import {
  type MultiplexedStreamCallbacks,
  type MultiplexerSubscriptionHandle,
  SubscriptionMultiplexer,
  type VenueHeartbeat,
  type VenueStreamProtocol,
} from "../../src/internal/subscription-multiplexer.ts";
import {
  expectPending,
  FakeWebSocket,
  waitForSocket,
} from "../support/test-utils.ts";

beforeEach(() => {
  FakeWebSocket.reset();
});

interface FakeDescriptor {
  key: string;
  connection: string;
}

interface FakePayload {
  value: string;
}

interface FakeMessage {
  ack?: boolean;
  key?: string;
  value?: string;
}

interface FakeControlFrame {
  op: "sub" | "unsub";
  keys: string[];
}

interface CallbackLog {
  payloads: { payload: FakePayload; receivedAt: number }[];
  freshness: {
    freshness: "fresh" | "stale";
    reason?: "heartbeat_timeout";
  }[];
  disconnected: number;
  errors: Error[];
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

const protocol: VenueStreamProtocol<FakeMessage, FakeDescriptor, FakePayload> =
  {
    subscriptionKey(descriptor): string {
      return descriptor.key;
    },
    connectionKey(descriptor): string {
      return descriptor.connection;
    },
    connectionUrl(connectionKey): string {
      return `wss://fake.test/${connectionKey}`;
    },
    parseMessage(data): FakeMessage | undefined {
      return JSON.parse(data) as FakeMessage;
    },
    encodeSubscribe(descriptors): string {
      return JSON.stringify({
        op: "sub",
        keys: descriptors.map((descriptor) => descriptor.key),
      } satisfies FakeControlFrame);
    },
    encodeUnsubscribe(descriptors): string {
      return JSON.stringify({
        op: "unsub",
        keys: descriptors.map((descriptor) => descriptor.key),
      } satisfies FakeControlFrame);
    },
    routeMessage(
      message,
    ):
      | { kind: "data"; subscriptionKey: string; payload: FakePayload }
      | { kind: "ack" }
      | { kind: "ignore" } {
      if (message.ack) {
        return { kind: "ack" };
      }

      if (message.key && message.value) {
        return {
          kind: "data",
          subscriptionKey: message.key,
          payload: { value: message.value },
        };
      }

      return { kind: "ignore" };
    },
  };

function createCallbacks(): {
  callbacks: MultiplexedStreamCallbacks<FakePayload>;
  log: CallbackLog;
} {
  const log: CallbackLog = {
    payloads: [],
    freshness: [],
    disconnected: 0,
    errors: [],
  };

  return {
    log,
    callbacks: {
      onPayload(payload, receivedAt): void {
        log.payloads.push({ payload, receivedAt });
      },
      onFreshnessChange(freshness, reason): void {
        log.freshness.push({ freshness, reason });
      },
      onDisconnected(): void {
        log.disconnected += 1;
      },
      onError(error): void {
        log.errors.push(error);
      },
    },
  };
}

function descriptor(key: string, connection = "alpha"): FakeDescriptor {
  return { key, connection };
}

function createMultiplexerWithProtocol(
  clock: FakeClock,
  testProtocol: VenueStreamProtocol<FakeMessage, FakeDescriptor, FakePayload>,
  controlFrameMaxPerSec = 5,
  maxSubscriptionsPerConnection?: number,
): SubscriptionMultiplexer<FakeMessage, FakeDescriptor, FakePayload> {
  return new SubscriptionMultiplexer(testProtocol, {
    initialMessageTimeoutMs: 5_000,
    staleAfterMs: 100,
    reconnectDelayMs: 10,
    reconnectMaxDelayMs: 10,
    controlFrameMaxPerSec,
    maxSubscriptionsPerConnection,
    now: clock.now,
    setTimer: clock.setTimer as unknown as typeof setTimeout,
    clearTimer: clock.clearTimer as unknown as typeof clearTimeout,
    createWebSocket(url): WebSocket {
      return new FakeWebSocket(url) as unknown as WebSocket;
    },
  });
}

function createMultiplexer(
  clock: FakeClock,
  controlFrameMaxPerSec = 5,
  maxSubscriptionsPerConnection?: number,
): SubscriptionMultiplexer<FakeMessage, FakeDescriptor, FakePayload> {
  return createMultiplexerWithProtocol(
    clock,
    protocol,
    controlFrameMaxPerSec,
    maxSubscriptionsPerConnection,
  );
}

function createHeartbeatProtocol(
  heartbeat: VenueHeartbeat,
  overrides: Partial<
    VenueStreamProtocol<FakeMessage, FakeDescriptor, FakePayload>
  > = {},
): VenueStreamProtocol<FakeMessage, FakeDescriptor, FakePayload> {
  return {
    ...protocol,
    ...overrides,
    heartbeat,
  };
}

async function openSocket(url: string): Promise<FakeWebSocket> {
  const socket = await waitForSocket(url);
  await Promise.resolve();
  return socket;
}

function emitRaw(socket: FakeWebSocket, data: string): void {
  socket.dispatchEvent(new MessageEvent("message", { data }));
}

function sentFrame(socket: FakeWebSocket, index: number): FakeControlFrame {
  const frame = socket.sentFrames[index];
  if (!frame) {
    throw new Error(`Missing sent frame ${index}`);
  }

  return JSON.parse(frame) as FakeControlFrame;
}

function socketsForUrl(url: string): FakeWebSocket[] {
  return FakeWebSocket.instances.filter((instance) => instance.url === url);
}

test("same connection key shares one socket and batches subscribe keys", async () => {
  const clock = new FakeClock();
  const multiplexer = createMultiplexer(clock);
  const a = createCallbacks();
  const b = createCallbacks();
  const c = createCallbacks();

  multiplexer.subscribe(descriptor("a"), a.callbacks);
  multiplexer.subscribe(descriptor("b"), b.callbacks);
  multiplexer.subscribe(descriptor("c"), c.callbacks);

  const socket = await openSocket("wss://fake.test/alpha");
  clock.advance(0);

  expect(
    FakeWebSocket.instances.filter(
      (instance) => instance.url === "wss://fake.test/alpha",
    ),
  ).toHaveLength(1);
  expect(socket.sentFrames).toHaveLength(1);
  expect(sentFrame(socket, 0)).toEqual({
    op: "sub",
    keys: ["a", "b", "c"],
  });
});

test("max subscriptions per connection creates a pool and partitions subscribe keys", async () => {
  const clock = new FakeClock();
  const multiplexer = createMultiplexer(clock, 5, 2);

  for (const key of ["a", "b", "c", "d", "e"]) {
    multiplexer.subscribe(descriptor(key), createCallbacks().callbacks);
  }

  const sockets = await Promise.all([
    waitForSocket("wss://fake.test/alpha", 0),
    waitForSocket("wss://fake.test/alpha", 1),
    waitForSocket("wss://fake.test/alpha", 2),
  ]);
  await Promise.resolve();
  clock.advance(0);

  expect(socketsForUrl("wss://fake.test/alpha")).toHaveLength(3);
  expect(sockets.map((socket) => sentFrame(socket, 0))).toEqual([
    { op: "sub", keys: ["a", "b"] },
    { op: "sub", keys: ["c", "d"] },
    { op: "sub", keys: ["e"] },
  ]);

  const subscribedKeys = sockets.flatMap((socket) => sentFrame(socket, 0).keys);
  expect(new Set(subscribedKeys).size).toBe(5);
  expect(subscribedKeys.sort()).toEqual(["a", "b", "c", "d", "e"]);
  for (const socket of sockets) {
    expect(sentFrame(socket, 0).keys.length).toBeLessThanOrEqual(2);
  }
});

test("data routes only within the pooled connection that owns the subscription", async () => {
  const clock = new FakeClock();
  const multiplexer = createMultiplexer(clock, 5, 2);
  const a = createCallbacks();
  const b = createCallbacks();
  const c = createCallbacks();

  multiplexer.subscribe(descriptor("a"), a.callbacks);
  multiplexer.subscribe(descriptor("b"), b.callbacks);
  multiplexer.subscribe(descriptor("c"), c.callbacks);

  await waitForSocket("wss://fake.test/alpha", 0);
  const secondSocket = await waitForSocket("wss://fake.test/alpha", 1);
  await Promise.resolve();
  clock.advance(0);

  secondSocket.emitJson({ key: "c", value: "C1" });

  expect(a.log.payloads).toHaveLength(0);
  expect(b.log.payloads).toHaveLength(0);
  expect(c.log.payloads.map((entry) => entry.payload.value)).toEqual(["C1"]);
});

test("unsubscribe frees capacity for the next subscription without opening a new socket", async () => {
  const clock = new FakeClock();
  const multiplexer = createMultiplexer(clock, 5, 2);
  const a = createCallbacks();
  const d = createCallbacks();
  const handleA = multiplexer.subscribe(descriptor("a"), a.callbacks);

  multiplexer.subscribe(descriptor("b"), createCallbacks().callbacks);
  multiplexer.subscribe(descriptor("c"), createCallbacks().callbacks);

  const firstSocket = await waitForSocket("wss://fake.test/alpha", 0);
  const secondSocket = await waitForSocket("wss://fake.test/alpha", 1);
  await Promise.resolve();
  clock.advance(0);

  handleA.close();
  multiplexer.subscribe(descriptor("d"), d.callbacks);

  expect(socketsForUrl("wss://fake.test/alpha")).toHaveLength(2);

  clock.advance(200);
  clock.advance(200);

  expect(sentFrame(firstSocket, 1)).toEqual({ op: "unsub", keys: ["a"] });
  expect(sentFrame(firstSocket, 2)).toEqual({ op: "sub", keys: ["d"] });
  expect(secondSocket.sentFrames).toHaveLength(1);

  firstSocket.emitJson({ key: "d", value: "D1" });

  expect(d.log.payloads.map((entry) => entry.payload.value)).toEqual(["D1"]);
});

test("re-subscribing an existing key in a pool shares the original connection", async () => {
  const clock = new FakeClock();
  const multiplexer = createMultiplexer(clock, 5, 2);
  const first = createCallbacks();
  const second = createCallbacks();

  multiplexer.subscribe(descriptor("a"), createCallbacks().callbacks);
  multiplexer.subscribe(descriptor("b"), createCallbacks().callbacks);
  const firstHandle = multiplexer.subscribe(descriptor("c"), first.callbacks);

  const firstSocket = await waitForSocket("wss://fake.test/alpha", 0);
  const secondSocket = await waitForSocket("wss://fake.test/alpha", 1);
  await Promise.resolve();
  clock.advance(0);
  firstSocket.emitJson({ key: "a", value: "A1" });
  firstSocket.emitJson({ key: "b", value: "B1" });

  const secondHandle = multiplexer.subscribe(descriptor("c"), second.callbacks);

  expect(socketsForUrl("wss://fake.test/alpha")).toHaveLength(2);
  expect(secondSocket.readyState).toBe(FakeWebSocket.OPEN);
  expect(secondSocket.sentFrames).toHaveLength(1);

  secondSocket.emitJson({ key: "c", value: "shared" });

  await Promise.all([firstHandle.ready, secondHandle.ready]);
  expect(first.log.payloads.map((entry) => entry.payload.value)).toEqual([
    "shared",
  ]);
  expect(second.log.payloads.map((entry) => entry.payload.value)).toEqual([
    "shared",
  ]);

  clock.advance(5_000);
  expect(secondSocket.readyState).toBe(FakeWebSocket.OPEN);
});

test("closing the last subscription on one pooled connection leaves siblings open", async () => {
  const clock = new FakeClock();
  const multiplexer = createMultiplexer(clock, 5, 2);
  const a = createCallbacks();

  multiplexer.subscribe(descriptor("a"), a.callbacks);
  multiplexer.subscribe(descriptor("b"), createCallbacks().callbacks);
  const handleC = multiplexer.subscribe(
    descriptor("c"),
    createCallbacks().callbacks,
  );

  const firstSocket = await waitForSocket("wss://fake.test/alpha", 0);
  const secondSocket = await waitForSocket("wss://fake.test/alpha", 1);
  await Promise.resolve();
  clock.advance(0);

  handleC.close();
  clock.advance(200);

  expect(sentFrame(secondSocket, 1)).toEqual({ op: "unsub", keys: ["c"] });
  expect(secondSocket.readyState).toBe(FakeWebSocket.CLOSED);
  expect(firstSocket.readyState).toBe(FakeWebSocket.OPEN);

  firstSocket.emitJson({ key: "a", value: "A1" });

  expect(a.log.payloads.map((entry) => entry.payload.value)).toEqual(["A1"]);
});

test("without max subscriptions the same connection key still uses one socket", async () => {
  const clock = new FakeClock();
  const multiplexer = createMultiplexer(clock);

  for (const key of ["a", "b", "c", "d", "e"]) {
    multiplexer.subscribe(descriptor(key), createCallbacks().callbacks);
  }

  const socket = await openSocket("wss://fake.test/alpha");
  clock.advance(0);

  expect(socketsForUrl("wss://fake.test/alpha")).toHaveLength(1);
  expect(sentFrame(socket, 0)).toEqual({
    op: "sub",
    keys: ["a", "b", "c", "d", "e"],
  });
});

test("different connection keys create separate sockets", async () => {
  const clock = new FakeClock();
  const multiplexer = createMultiplexer(clock);

  multiplexer.subscribe(descriptor("a", "alpha"), createCallbacks().callbacks);
  multiplexer.subscribe(descriptor("b", "beta"), createCallbacks().callbacks);

  await openSocket("wss://fake.test/alpha");
  await openSocket("wss://fake.test/beta");

  expect(
    FakeWebSocket.instances
      .map((socket) => socket.url)
      .filter((url) => url.startsWith("wss://fake.test/"))
      .sort(),
  ).toEqual(["wss://fake.test/alpha", "wss://fake.test/beta"]);
});

test("subscription ready resolves only after its first data message", async () => {
  const clock = new FakeClock();
  const multiplexer = createMultiplexer(clock);
  const { callbacks } = createCallbacks();
  const handle = multiplexer.subscribe(descriptor("a"), callbacks);

  const socket = await openSocket("wss://fake.test/alpha");
  clock.advance(0);

  await expectPending(handle.ready);

  socket.emitJson({ key: "a", value: "first" });

  await handle.ready;
});

test("re-subscribing the only key shares callbacks without rebuilding the socket", async () => {
  const clock = new FakeClock();
  const multiplexer = createMultiplexer(clock);
  const first = createCallbacks();
  const second = createCallbacks();

  const firstHandle = multiplexer.subscribe(descriptor("a"), first.callbacks);

  const socket = await openSocket("wss://fake.test/alpha");
  clock.advance(0);

  const secondHandle = multiplexer.subscribe(descriptor("a"), second.callbacks);

  expect(
    FakeWebSocket.instances.filter(
      (instance) => instance.url === "wss://fake.test/alpha",
    ),
  ).toHaveLength(1);
  expect(socket.readyState).toBe(FakeWebSocket.OPEN);
  expect(socket.sentFrames).toHaveLength(1);

  socket.emitJson({ key: "a", value: "shared" });

  await Promise.all([firstHandle.ready, secondHandle.ready]);
  expect(first.log.payloads.map((entry) => entry.payload.value)).toEqual([
    "shared",
  ]);
  expect(second.log.payloads.map((entry) => entry.payload.value)).toEqual([
    "shared",
  ]);

  clock.advance(5_000);
  expect(socket.readyState).toBe(FakeWebSocket.OPEN);

  socket.emitJson({ key: "a", value: "after-timeout" });

  expect(first.log.payloads.map((entry) => entry.payload.value)).toEqual([
    "shared",
    "after-timeout",
  ]);
  expect(second.log.payloads.map((entry) => entry.payload.value)).toEqual([
    "shared",
    "after-timeout",
  ]);
});

test("subscribing the same key during payload delivery does not receive the in-flight message", async () => {
  const clock = new FakeClock();
  const multiplexer = createMultiplexer(clock);
  const first = createCallbacks();
  const second = createCallbacks();
  let secondHandle: MultiplexerSubscriptionHandle | undefined;

  const firstHandle = multiplexer.subscribe(descriptor("a"), {
    ...first.callbacks,
    onPayload(payload, receivedAt): void {
      first.log.payloads.push({ payload, receivedAt });
      if (!secondHandle) {
        secondHandle = multiplexer.subscribe(descriptor("a"), second.callbacks);
      }
    },
  });

  const socket = await openSocket("wss://fake.test/alpha");
  clock.advance(0);

  socket.emitJson({ key: "a", value: "M1" });

  await firstHandle.ready;
  expect(first.log.payloads.map((entry) => entry.payload.value)).toEqual([
    "M1",
  ]);
  const createdSecondHandle = secondHandle;
  if (!createdSecondHandle) {
    throw new Error("Expected the second subscription to be created");
  }
  expect(second.log.payloads).toHaveLength(0);
  await expectPending(createdSecondHandle.ready);

  socket.emitJson({ key: "a", value: "M2" });

  await createdSecondHandle.ready;
  expect(first.log.payloads.map((entry) => entry.payload.value)).toEqual([
    "M1",
    "M2",
  ]);
  expect(second.log.payloads.map((entry) => entry.payload.value)).toEqual([
    "M2",
  ]);
});

test("closing one shared handle leaves the remote subscription active", async () => {
  const clock = new FakeClock();
  const multiplexer = createMultiplexer(clock);
  const first = createCallbacks();
  const second = createCallbacks();
  const firstHandle = multiplexer.subscribe(descriptor("a"), first.callbacks);

  const socket = await openSocket("wss://fake.test/alpha");
  clock.advance(0);

  const secondHandle = multiplexer.subscribe(descriptor("a"), second.callbacks);

  socket.emitJson({ key: "a", value: "shared" });

  await Promise.all([firstHandle.ready, secondHandle.ready]);

  firstHandle.close();

  expect(socket.readyState).toBe(FakeWebSocket.OPEN);
  expect(socketsForUrl("wss://fake.test/alpha")).toHaveLength(1);
  clock.advance(200);
  expect(socket.sentFrames).toHaveLength(1);

  socket.emitJson({ key: "a", value: "after-old-close" });

  expect(first.log.payloads.map((entry) => entry.payload.value)).toEqual([
    "shared",
  ]);
  expect(second.log.payloads.map((entry) => entry.payload.value)).toEqual([
    "shared",
    "after-old-close",
  ]);

  secondHandle.close();
  clock.advance(200);

  expect(sentFrame(socket, 1)).toEqual({ op: "unsub", keys: ["a"] });
  expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
});

test("data messages route only to the matching subscription", async () => {
  const clock = new FakeClock();
  const multiplexer = createMultiplexer(clock);
  const a = createCallbacks();
  const b = createCallbacks();

  multiplexer.subscribe(descriptor("a"), a.callbacks);
  multiplexer.subscribe(descriptor("b"), b.callbacks);

  const socket = await openSocket("wss://fake.test/alpha");
  clock.advance(0);
  socket.emitJson({ key: "a", value: "A1" });
  socket.emitJson({ key: "b", value: "B1" });

  expect(a.log.payloads.map((entry) => entry.payload.value)).toEqual(["A1"]);
  expect(b.log.payloads.map((entry) => entry.payload.value)).toEqual(["B1"]);
});

test("closing one subscription sends unsubscribe and keeps sibling active", async () => {
  const clock = new FakeClock();
  const multiplexer = createMultiplexer(clock);
  const a = createCallbacks();
  const b = createCallbacks();
  const handleA = multiplexer.subscribe(descriptor("a"), a.callbacks);
  multiplexer.subscribe(descriptor("b"), b.callbacks);

  const socket = await openSocket("wss://fake.test/alpha");
  clock.advance(0);
  handleA.close();
  clock.advance(200);

  expect(sentFrame(socket, 1)).toEqual({ op: "unsub", keys: ["a"] });
  expect(socket.readyState).toBe(FakeWebSocket.OPEN);

  socket.emitJson({ key: "b", value: "still-active" });

  expect(a.log.payloads).toHaveLength(0);
  expect(b.log.payloads.map((entry) => entry.payload.value)).toEqual([
    "still-active",
  ]);
});

test("closing the last subscription closes and removes the pooled connection", async () => {
  const clock = new FakeClock();
  const multiplexer = createMultiplexer(clock);
  const handle = multiplexer.subscribe(
    descriptor("a"),
    createCallbacks().callbacks,
  );

  const socket = await openSocket("wss://fake.test/alpha");
  clock.advance(0);
  handle.close();

  clock.advance(200);

  expect(sentFrame(socket, 1)).toEqual({ op: "unsub", keys: ["a"] });
  expect(socket.readyState).toBe(FakeWebSocket.CLOSED);

  multiplexer.subscribe(descriptor("b"), createCallbacks().callbacks);
  const nextSocket = await waitForSocket("wss://fake.test/alpha", 1);

  expect(nextSocket).not.toBe(socket);
});

test("retired connection does not reconnect when socket closes before unsubscribe flush", async () => {
  const clock = new FakeClock();
  const multiplexer = createMultiplexer(clock, 1);
  const callbacks = createCallbacks();
  const handle = multiplexer.subscribe(descriptor("a"), callbacks.callbacks);

  const socket = await openSocket("wss://fake.test/alpha");
  clock.advance(0);
  socket.emitJson({ key: "a", value: "ready" });
  await handle.ready;

  handle.close();

  clock.advance(999);
  expect(socket.sentFrames).toHaveLength(1);

  socket.disconnect();
  clock.advance(10);

  expect(socketsForUrl("wss://fake.test/alpha")).toHaveLength(1);
  expect(socket.readyState).toBe(FakeWebSocket.CLOSED);

  multiplexer.subscribe(descriptor("b"), createCallbacks().callbacks);
  const nextSocket = await waitForSocket("wss://fake.test/alpha", 1);

  expect(nextSocket).not.toBe(socket);
});

test("reconnect creates a new socket and replays active subscriptions", async () => {
  const clock = new FakeClock();
  const multiplexer = createMultiplexer(clock);
  const a = createCallbacks();
  const b = createCallbacks();

  multiplexer.subscribe(descriptor("a"), a.callbacks);
  multiplexer.subscribe(descriptor("b"), b.callbacks);

  const socket = await openSocket("wss://fake.test/alpha");
  clock.advance(0);
  socket.emitJson({ key: "a", value: "A1" });
  socket.emitJson({ key: "b", value: "B1" });

  expect(a.log.freshness).toEqual([{ freshness: "fresh" }]);
  expect(b.log.freshness).toEqual([{ freshness: "fresh" }]);

  socket.disconnect();

  expect(a.log.disconnected).toBe(1);
  expect(b.log.disconnected).toBe(1);
  expect(a.log.freshness).not.toContainEqual({
    freshness: "stale",
    reason: "heartbeat_timeout",
  });
  expect(b.log.freshness).not.toContainEqual({
    freshness: "stale",
    reason: "heartbeat_timeout",
  });

  clock.advance(10);
  const reconnectSocket = await waitForSocket("wss://fake.test/alpha", 1);
  await Promise.resolve();
  clock.advance(0);

  expect(reconnectSocket.sentFrames).toHaveLength(1);
  expect(sentFrame(reconnectSocket, 0)).toEqual({
    op: "sub",
    keys: ["a", "b"],
  });

  reconnectSocket.emitJson({ key: "a", value: "A2" });
  expect(a.log.freshness).toEqual([
    { freshness: "fresh" },
    { freshness: "fresh" },
  ]);
});

test("quiet subscription stays fresh while the shared connection receives other data", async () => {
  const clock = new FakeClock();
  const multiplexer = createMultiplexer(clock);
  const a = createCallbacks();
  const b = createCallbacks();

  multiplexer.subscribe(descriptor("a"), a.callbacks);
  multiplexer.subscribe(descriptor("b"), b.callbacks);

  const socket = await openSocket("wss://fake.test/alpha");
  clock.advance(0);
  socket.emitJson({ key: "a", value: "A1" });
  socket.emitJson({ key: "b", value: "B1" });
  clock.advance(90);
  socket.emitJson({ key: "a", value: "A2" });
  clock.advance(10);

  expect(a.log.freshness).toEqual([{ freshness: "fresh" }]);
  expect(b.log.freshness).toEqual([{ freshness: "fresh" }]);

  clock.advance(89);
  expect(a.log.freshness).toEqual([{ freshness: "fresh" }]);
  expect(b.log.freshness).toEqual([{ freshness: "fresh" }]);

  clock.advance(1);
  expect(a.log.freshness).toEqual([
    { freshness: "fresh" },
    { freshness: "stale", reason: "heartbeat_timeout" },
  ]);
  expect(b.log.freshness).toEqual([
    { freshness: "fresh" },
    { freshness: "stale", reason: "heartbeat_timeout" },
  ]);
});

test("control frames are batched and throttled per connection", async () => {
  const clock = new FakeClock();
  const multiplexer = createMultiplexer(clock, 1);

  multiplexer.subscribe(descriptor("a"), createCallbacks().callbacks);
  const socket = await openSocket("wss://fake.test/alpha");
  clock.advance(0);

  multiplexer.subscribe(descriptor("b"), createCallbacks().callbacks);
  multiplexer.subscribe(descriptor("c"), createCallbacks().callbacks);
  multiplexer.subscribe(descriptor("d"), createCallbacks().callbacks);

  clock.advance(999);
  expect(socket.sentFrames).toHaveLength(1);

  clock.advance(1);
  expect(socket.sentFrames).toHaveLength(2);
  expect(sentFrame(socket, 1)).toEqual({
    op: "sub",
    keys: ["b", "c", "d"],
  });
});

test("ack frames do not trigger payload callbacks", async () => {
  const clock = new FakeClock();
  const multiplexer = createMultiplexer(clock);
  const { callbacks, log } = createCallbacks();
  const handle = multiplexer.subscribe(descriptor("a"), callbacks);

  const socket = await openSocket("wss://fake.test/alpha");
  clock.advance(0);
  socket.emitJson({ ack: true });

  expect(log.payloads).toHaveLength(0);
  await expectPending(handle.ready);
});

test("heartbeat idle-timeout sends ping only after inbound idle interval", async () => {
  const clock = new FakeClock();
  const heartbeatProtocol = createHeartbeatProtocol({
    intervalMs: 50,
    mode: "idle-timeout",
    frame: () => "ping",
    isPong: (raw) => raw === "pong",
  });
  const multiplexer = createMultiplexerWithProtocol(clock, heartbeatProtocol);

  multiplexer.subscribe(descriptor("a"), createCallbacks().callbacks);

  const socket = await openSocket("wss://fake.test/alpha");
  clock.advance(0);

  expect(socket.sentFrames).toEqual([
    JSON.stringify({ op: "sub", keys: ["a"] } satisfies FakeControlFrame),
  ]);

  clock.advance(49);
  expect(socket.sentFrames).toHaveLength(1);

  clock.advance(1);
  expect(socket.sentFrames).toHaveLength(2);
  expect(socket.sentFrames[1]).toBe("ping");
});

test("heartbeat fixed-interval sends ping every interval", async () => {
  const clock = new FakeClock();
  const heartbeatProtocol = createHeartbeatProtocol({
    intervalMs: 25,
    mode: "fixed-interval",
    frame: () => "ping",
    isPong: (raw) => raw === "pong",
  });
  const multiplexer = createMultiplexerWithProtocol(clock, heartbeatProtocol);

  multiplexer.subscribe(descriptor("a"), createCallbacks().callbacks);

  const socket = await openSocket("wss://fake.test/alpha");
  clock.advance(0);
  clock.advance(25);
  clock.advance(25);

  expect(socket.sentFrames).toEqual([
    JSON.stringify({ op: "sub", keys: ["a"] } satisfies FakeControlFrame),
    "ping",
    "ping",
  ]);
});

test("heartbeat countAnyInboundAsActivity resets idle timer", async () => {
  const clock = new FakeClock();
  const heartbeatProtocol = createHeartbeatProtocol({
    intervalMs: 50,
    mode: "idle-timeout",
    frame: () => "ping",
    isPong: (raw) => raw === "pong",
  });
  const multiplexer = createMultiplexerWithProtocol(clock, heartbeatProtocol);

  multiplexer.subscribe(descriptor("a"), createCallbacks().callbacks);

  const socket = await openSocket("wss://fake.test/alpha");
  clock.advance(0);
  clock.advance(30);
  socket.emitJson({ ack: true });
  clock.advance(49);

  expect(socket.sentFrames).toHaveLength(1);

  clock.advance(1);
  expect(socket.sentFrames).toHaveLength(2);
  expect(socket.sentFrames[1]).toBe("ping");
});

test("heartbeat pong is consumed before parse and clears pending pong", async () => {
  const clock = new FakeClock();
  let parseCalls = 0;
  const heartbeatProtocol = createHeartbeatProtocol(
    {
      intervalMs: 10,
      mode: "fixed-interval",
      pongTimeoutMs: 20,
      frame: () => "ping",
      isPong: (raw) => raw === "pong",
    },
    {
      parseMessage(data): FakeMessage | undefined {
        parseCalls += 1;
        return protocol.parseMessage(data);
      },
    },
  );
  const multiplexer = createMultiplexerWithProtocol(clock, heartbeatProtocol);
  const { callbacks, log } = createCallbacks();

  multiplexer.subscribe(descriptor("a"), callbacks);

  const socket = await openSocket("wss://fake.test/alpha");
  clock.advance(0);
  clock.advance(10);

  expect(socket.sentFrames.at(-1)).toBe("ping");

  emitRaw(socket, "pong");
  clock.advance(20);

  expect(parseCalls).toBe(0);
  expect(log.payloads).toHaveLength(0);
  expect(log.errors).toHaveLength(0);
  expect(socket.readyState).toBe(FakeWebSocket.OPEN);
  expect(socketsForUrl("wss://fake.test/alpha")).toHaveLength(1);
});

test("heartbeat pong timeout reconnects and replays shared subscriptions", async () => {
  const clock = new FakeClock();
  const heartbeatProtocol = createHeartbeatProtocol({
    intervalMs: 10,
    mode: "fixed-interval",
    pongTimeoutMs: 25,
    frame: () => "ping",
    isPong: (raw) => raw === "pong",
  });
  const multiplexer = createMultiplexerWithProtocol(clock, heartbeatProtocol);
  const first = createCallbacks();
  const second = createCallbacks();

  const firstHandle = multiplexer.subscribe(descriptor("a"), first.callbacks);
  const secondHandle = multiplexer.subscribe(descriptor("a"), second.callbacks);

  const socket = await openSocket("wss://fake.test/alpha");
  clock.advance(0);
  clock.advance(10);
  const oldFrameCount = socket.sentFrames.length;

  clock.advance(10);
  expect(socket.sentFrames).toHaveLength(oldFrameCount);
  expect(socket.readyState).toBe(FakeWebSocket.OPEN);

  clock.advance(15);
  expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  expect(first.log.disconnected).toBe(1);
  expect(second.log.disconnected).toBe(1);

  clock.advance(10);
  const reconnectSocket = await waitForSocket("wss://fake.test/alpha", 1);
  await Promise.resolve();
  clock.advance(0);

  expect(sentFrame(reconnectSocket, 0)).toEqual({
    op: "sub",
    keys: ["a"],
  });

  reconnectSocket.emitJson({ key: "a", value: "after-reconnect" });
  await Promise.all([firstHandle.ready, secondHandle.ready]);

  expect(first.log.payloads.map((entry) => entry.payload.value)).toEqual([
    "after-reconnect",
  ]);
  expect(second.log.payloads.map((entry) => entry.payload.value)).toEqual([
    "after-reconnect",
  ]);

  clock.advance(10);
  expect(socket.sentFrames).toHaveLength(oldFrameCount);
  expect(reconnectSocket.sentFrames.at(-1)).toBe("ping");
});

test("heartbeat timers are cleared when the connection closes", async () => {
  const clock = new FakeClock();
  const heartbeatProtocol = createHeartbeatProtocol({
    intervalMs: 10,
    mode: "fixed-interval",
    pongTimeoutMs: 30,
    frame: () => "ping",
    isPong: (raw) => raw === "pong",
  });
  const multiplexer = createMultiplexerWithProtocol(clock, heartbeatProtocol);
  const handle = multiplexer.subscribe(
    descriptor("a"),
    createCallbacks().callbacks,
  );

  const socket = await openSocket("wss://fake.test/alpha");
  clock.advance(0);
  clock.advance(10);
  expect(socket.sentFrames.at(-1)).toBe("ping");

  handle.close();
  clock.advance(200);

  const frameCountAfterClose = socket.sentFrames.length;
  expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  expect(clock.timerCount).toBe(0);

  clock.advance(1_000);
  expect(socket.sentFrames).toHaveLength(frameCountAfterClose);
  expect(socketsForUrl("wss://fake.test/alpha")).toHaveLength(1);
});

test("connections without heartbeat do not send application pings when idle", async () => {
  const clock = new FakeClock();
  const multiplexer = createMultiplexer(clock);

  multiplexer.subscribe(descriptor("a"), createCallbacks().callbacks);

  const socket = await openSocket("wss://fake.test/alpha");
  clock.advance(0);
  clock.advance(1_000);

  expect(socket.sentFrames).toEqual([
    JSON.stringify({ op: "sub", keys: ["a"] } satisfies FakeControlFrame),
  ]);
  expect(socketsForUrl("wss://fake.test/alpha")).toHaveLength(1);
});
