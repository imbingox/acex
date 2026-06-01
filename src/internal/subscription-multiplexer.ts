import {
  createManagedWebSocket,
  type ManagedWebSocketSession,
  type WebSocketFactory,
} from "./managed-websocket.ts";

type TimerHandle = ReturnType<typeof setTimeout>;
type Freshness = "fresh" | "stale";
type StaleReason = "heartbeat_timeout";
type ControlFrameKind = "subscribe" | "unsubscribe";

export interface MultiplexerSubscriptionHandle {
  readonly ready: Promise<void>;
  close(): void;
}

export interface MultiplexedStreamCallbacks<TPayload> {
  onPayload(payload: TPayload, receivedAt: number): void;
  onFreshnessChange(freshness: Freshness, reason?: StaleReason): void;
  onDisconnected(): void;
  onError(error: Error): void;
}

export interface VenueStreamProtocol<TMessage, TDescriptor, TPayload> {
  subscriptionKey(descriptor: TDescriptor): string;
  connectionKey(descriptor: TDescriptor): string;
  connectionUrl(connectionKey: string): string;
  parseMessage(data: string): TMessage | undefined;
  encodeSubscribe(descriptors: TDescriptor[]): string;
  encodeUnsubscribe(descriptors: TDescriptor[]): string;
  routeMessage(
    message: TMessage,
  ):
    | { kind: "data"; subscriptionKey: string; payload: TPayload }
    | { kind: "ack" }
    | { kind: "ignore" };
}

export interface SubscriptionMultiplexerOptions {
  initialMessageTimeoutMs: number;
  staleAfterMs: number;
  reconnectDelayMs: number;
  reconnectMaxDelayMs: number;
  controlFrameMaxPerSec?: number;
  maxSubscriptionsPerConnection?: number;
  now?: () => number;
  createWebSocket?: WebSocketFactory;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

interface Deferred {
  resolve(): void;
  reject(error: Error): void;
}

interface LocalSubscriber<TPayload> {
  readonly callbacks: MultiplexedStreamCallbacks<TPayload>;
  readonly ready: Promise<void>;
  readonly deferred: Deferred;
  readySettled: boolean;
  freshness: Freshness;
  initialTimer: TimerHandle | undefined;
}

interface SubState<TDescriptor, TPayload> {
  readonly descriptor: TDescriptor;
  readonly subscribers: Set<LocalSubscriber<TPayload>>;
  lastMessageAt: number | undefined;
  staleTimer: TimerHandle | undefined;
}

interface ControlFrame<TDescriptor> {
  readonly kind: ControlFrameKind;
  readonly descriptors: Map<string, TDescriptor>;
}

interface ConnectionState<TDescriptor, TPayload> {
  readonly key: string;
  readonly url: string;
  readonly subs: Map<string, SubState<TDescriptor, TPayload>>;
  readonly controlQueue: ControlFrame<TDescriptor>[];
  session: ManagedWebSocketSession;
  isOpen: boolean;
  hasOpened: boolean;
  closeAfterControlQueueDrained: boolean;
  controlTimer: TimerHandle | undefined;
  lastControlSentAt: number | undefined;
}

function createDeferred(): { promise: Promise<void>; deferred: Deferred } {
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  return {
    promise,
    deferred: {
      resolve(): void {
        resolveReady?.();
      },
      reject(error: Error): void {
        rejectReady?.(error);
      },
    },
  };
}

function eventError(event: Event): Error {
  if (event instanceof ErrorEvent && event.error instanceof Error) {
    return event.error;
  }

  return new Error(`WebSocket error: ${event.type}`);
}

export class SubscriptionMultiplexer<TMessage, TDescriptor, TPayload> {
  private readonly connections = new Map<
    string,
    ConnectionState<TDescriptor, TPayload>[]
  >();

  private readonly now: () => number;
  private readonly createWebSocket: WebSocketFactory | undefined;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly controlFrameIntervalMs: number;
  private readonly maxSubscriptionsPerConnection: number | undefined;

  constructor(
    private readonly protocol: VenueStreamProtocol<
      TMessage,
      TDescriptor,
      TPayload
    >,
    private readonly options: SubscriptionMultiplexerOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.createWebSocket = options.createWebSocket;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.controlFrameIntervalMs = 1_000 / (options.controlFrameMaxPerSec ?? 5);
    this.maxSubscriptionsPerConnection = options.maxSubscriptionsPerConnection;
  }

  subscribe(
    descriptor: TDescriptor,
    callbacks: MultiplexedStreamCallbacks<TPayload>,
  ): MultiplexerSubscriptionHandle {
    const subscriptionKey = this.protocol.subscriptionKey(descriptor);
    const connectionKey = this.protocol.connectionKey(descriptor);
    const existingConnection = this.findConnectionWithSubscription(
      connectionKey,
      subscriptionKey,
    );
    const connection =
      existingConnection ?? this.getOrCreateConnection(connectionKey);
    const { promise, deferred } = createDeferred();
    const localSubscriber: LocalSubscriber<TPayload> = {
      callbacks,
      ready: promise,
      deferred,
      readySettled: false,
      freshness: "stale",
      initialTimer: undefined,
    };

    const existing = connection.subs.get(subscriptionKey);
    if (existing) {
      existing.subscribers.add(localSubscriber);
      this.scheduleInitialTimeout(
        connection,
        subscriptionKey,
        existing,
        localSubscriber,
      );

      return this.createHandle(
        connection,
        subscriptionKey,
        promise,
        localSubscriber,
      );
    }

    const sub: SubState<TDescriptor, TPayload> = {
      descriptor,
      subscribers: new Set([localSubscriber]),
      lastMessageAt: undefined,
      staleTimer: undefined,
    };

    connection.subs.set(subscriptionKey, sub);
    this.scheduleInitialTimeout(
      connection,
      subscriptionKey,
      sub,
      localSubscriber,
    );
    this.scheduleSubStaleTimeout(connection, sub);

    if (connection.isOpen) {
      this.enqueueControlFrame(connection, "subscribe", [
        [subscriptionKey, descriptor],
      ]);
    }

    return this.createHandle(
      connection,
      subscriptionKey,
      promise,
      localSubscriber,
    );
  }

  private createHandle(
    connection: ConnectionState<TDescriptor, TPayload>,
    subscriptionKey: string,
    ready: Promise<void>,
    localSubscriber: LocalSubscriber<TPayload>,
  ): MultiplexerSubscriptionHandle {
    let closed = false;
    return {
      ready,
      close: (): void => {
        if (closed) {
          return;
        }

        closed = true;
        this.removeSubscription(
          connection,
          subscriptionKey,
          connection.isOpen,
          localSubscriber,
        );
      },
    };
  }

  private getOrCreateConnection(
    connectionKey: string,
  ): ConnectionState<TDescriptor, TPayload> {
    const pool = this.connections.get(connectionKey);
    if (pool) {
      for (const connection of pool) {
        if (this.hasSubscriptionCapacity(connection)) {
          return connection;
        }
      }
    }

    return this.createConnection(connectionKey);
  }

  private createConnection(
    connectionKey: string,
  ): ConnectionState<TDescriptor, TPayload> {
    const connection: ConnectionState<TDescriptor, TPayload> = {
      key: connectionKey,
      url: this.protocol.connectionUrl(connectionKey),
      subs: new Map(),
      controlQueue: [],
      session: undefined as unknown as ManagedWebSocketSession,
      isOpen: false,
      hasOpened: false,
      closeAfterControlQueueDrained: false,
      controlTimer: undefined,
      lastControlSentAt: undefined,
    };

    connection.session = createManagedWebSocket<TMessage>({
      url: connection.url,
      initialMessageTimeoutMs: this.options.initialMessageTimeoutMs,
      readyWhen: "open",
      parseMessage: (data) => this.protocol.parseMessage(data),
      onMessage: (message, receivedAt) => {
        this.handleMessage(connection, message, receivedAt);
      },
      onUnexpectedClose: () => {
        this.handleUnexpectedClose(connection);
      },
      onOpen: () => {
        this.handleOpen(connection);
      },
      onError: (event) => {
        this.notifyConnectionError(connection, eventError(event));
      },
      messageWatchdog: {
        staleAfterMs: this.options.staleAfterMs,
        onStale: () => {
          this.markAllStale(connection, "heartbeat_timeout");
        },
      },
      reconnect: {
        initialDelayMs: this.options.reconnectDelayMs,
        maxDelayMs: this.options.reconnectMaxDelayMs,
        reconnectWithoutMessages: true,
      },
      now: this.now,
      createWebSocket: this.createWebSocket,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
    });
    this.addConnectionToPool(connection);

    return connection;
  }

  private hasSubscriptionCapacity(
    connection: ConnectionState<TDescriptor, TPayload>,
  ): boolean {
    return (
      this.maxSubscriptionsPerConnection === undefined ||
      connection.subs.size < this.maxSubscriptionsPerConnection
    );
  }

  private findConnectionWithSubscription(
    connectionKey: string,
    subscriptionKey: string,
  ): ConnectionState<TDescriptor, TPayload> | undefined {
    const pool = this.connections.get(connectionKey);
    if (!pool) {
      return undefined;
    }

    for (const connection of pool) {
      if (connection.subs.has(subscriptionKey)) {
        return connection;
      }
    }

    return undefined;
  }

  private addConnectionToPool(
    connection: ConnectionState<TDescriptor, TPayload>,
  ): void {
    const pool = this.connections.get(connection.key);
    if (pool) {
      pool.push(connection);
      return;
    }

    this.connections.set(connection.key, [connection]);
  }

  private removeConnectionFromPool(
    connection: ConnectionState<TDescriptor, TPayload>,
  ): void {
    const pool = this.connections.get(connection.key);
    if (!pool) {
      return;
    }

    const index = pool.indexOf(connection);
    if (index >= 0) {
      pool.splice(index, 1);
    }

    if (pool.length === 0) {
      this.connections.delete(connection.key);
    }
  }

  private handleOpen(connection: ConnectionState<TDescriptor, TPayload>): void {
    connection.isOpen = true;
    connection.lastControlSentAt = undefined;

    if (connection.hasOpened) {
      this.markAllStale(connection, "heartbeat_timeout");
    }
    connection.hasOpened = true;

    this.enqueueControlFrame(
      connection,
      "subscribe",
      [...connection.subs].map(([subscriptionKey, sub]) => [
        subscriptionKey,
        sub.descriptor,
      ]),
    );
  }

  private handleUnexpectedClose(
    connection: ConnectionState<TDescriptor, TPayload>,
  ): void {
    connection.isOpen = false;
    connection.lastControlSentAt = undefined;
    if (connection.controlTimer) {
      this.clearTimer(connection.controlTimer);
      connection.controlTimer = undefined;
    }

    if (connection.subs.size === 0) {
      this.closeConnection(connection);
      return;
    }

    this.markAllStaleSilently(connection);
    for (const sub of connection.subs.values()) {
      for (const localSubscriber of sub.subscribers) {
        localSubscriber.callbacks.onDisconnected();
      }
    }
  }

  private handleMessage(
    connection: ConnectionState<TDescriptor, TPayload>,
    message: TMessage,
    receivedAt: number,
  ): void {
    const routed = this.protocol.routeMessage(message);
    if (routed.kind !== "data") {
      return;
    }

    const sub = connection.subs.get(routed.subscriptionKey);
    if (!sub) {
      return;
    }

    sub.lastMessageAt = receivedAt;
    this.scheduleSubStaleTimeout(connection, sub);

    for (const localSubscriber of [...sub.subscribers]) {
      if (!sub.subscribers.has(localSubscriber)) {
        continue;
      }

      this.clearInitialTimer(localSubscriber);
      this.resolveSubReady(localSubscriber);

      if (localSubscriber.freshness !== "fresh") {
        localSubscriber.freshness = "fresh";
        localSubscriber.callbacks.onFreshnessChange("fresh");
      }

      if (sub.subscribers.has(localSubscriber)) {
        localSubscriber.callbacks.onPayload(routed.payload, receivedAt);
      }
    }
  }

  private scheduleInitialTimeout(
    connection: ConnectionState<TDescriptor, TPayload>,
    subscriptionKey: string,
    sub: SubState<TDescriptor, TPayload>,
    localSubscriber: LocalSubscriber<TPayload>,
  ): void {
    localSubscriber.initialTimer = this.setTimer(() => {
      localSubscriber.initialTimer = undefined;
      if (
        connection.subs.get(subscriptionKey) !== sub ||
        !sub.subscribers.has(localSubscriber) ||
        localSubscriber.readySettled
      ) {
        return;
      }

      localSubscriber.readySettled = true;
      localSubscriber.deferred.reject(
        new Error(
          `Timed out waiting for first data message for ${subscriptionKey}`,
        ),
      );
      this.removeSubscription(
        connection,
        subscriptionKey,
        connection.isOpen,
        localSubscriber,
      );
    }, this.options.initialMessageTimeoutMs);
  }

  private scheduleSubStaleTimeout(
    connection: ConnectionState<TDescriptor, TPayload>,
    sub: SubState<TDescriptor, TPayload>,
  ): void {
    if (sub.staleTimer) {
      this.clearTimer(sub.staleTimer);
    }

    sub.staleTimer = this.setTimer(() => {
      const subscriptionKey = this.protocol.subscriptionKey(sub.descriptor);
      if (connection.subs.get(subscriptionKey) !== sub) {
        return;
      }

      this.markSubStale(sub, "heartbeat_timeout");
    }, this.options.staleAfterMs);
  }

  private clearInitialTimer(localSubscriber: LocalSubscriber<TPayload>): void {
    if (!localSubscriber.initialTimer) {
      return;
    }

    this.clearTimer(localSubscriber.initialTimer);
    localSubscriber.initialTimer = undefined;
  }

  private clearSubTimers(sub: SubState<TDescriptor, TPayload>): void {
    for (const localSubscriber of sub.subscribers) {
      this.clearInitialTimer(localSubscriber);
    }
    if (sub.staleTimer) {
      this.clearTimer(sub.staleTimer);
      sub.staleTimer = undefined;
    }
  }

  private resolveSubReady(localSubscriber: LocalSubscriber<TPayload>): void {
    if (localSubscriber.readySettled) {
      return;
    }

    localSubscriber.readySettled = true;
    localSubscriber.deferred.resolve();
  }

  private removeSubscription(
    connection: ConnectionState<TDescriptor, TPayload>,
    subscriptionKey: string,
    sendUnsubscribe: boolean,
    localSubscriber?: LocalSubscriber<TPayload>,
  ): void {
    const sub = connection.subs.get(subscriptionKey);
    if (!sub) {
      return;
    }

    if (localSubscriber && !sub.subscribers.has(localSubscriber)) {
      return;
    }

    if (localSubscriber) {
      this.clearInitialTimer(localSubscriber);
      sub.subscribers.delete(localSubscriber);
    }

    if (sub.subscribers.size > 0) {
      return;
    }

    connection.subs.delete(subscriptionKey);
    this.clearSubTimers(sub);
    this.removeQueuedDescriptor(connection, "subscribe", subscriptionKey);

    if (sendUnsubscribe) {
      this.enqueueControlFrame(connection, "unsubscribe", [
        [subscriptionKey, sub.descriptor],
      ]);
    }

    if (connection.subs.size === 0) {
      if (sendUnsubscribe && connection.isOpen) {
        this.retireConnectionAfterControlFlush(connection);
      } else {
        this.closeConnection(connection);
      }
    }
  }

  private retireConnectionAfterControlFlush(
    connection: ConnectionState<TDescriptor, TPayload>,
  ): void {
    connection.closeAfterControlQueueDrained = true;
    this.removeConnectionFromPool(connection);
    this.scheduleControlFlush(connection);
  }

  private closeConnection(
    connection: ConnectionState<TDescriptor, TPayload>,
  ): void {
    if (connection.controlTimer) {
      this.clearTimer(connection.controlTimer);
      connection.controlTimer = undefined;
    }

    connection.controlQueue.length = 0;
    connection.session.close();
    this.removeConnectionFromPool(connection);
  }

  private markAllStale(
    connection: ConnectionState<TDescriptor, TPayload>,
    reason: StaleReason,
  ): void {
    for (const sub of connection.subs.values()) {
      this.markSubStale(sub, reason);
    }
  }

  private markAllStaleSilently(
    connection: ConnectionState<TDescriptor, TPayload>,
  ): void {
    for (const sub of connection.subs.values()) {
      for (const localSubscriber of sub.subscribers) {
        localSubscriber.freshness = "stale";
      }
    }
  }

  private markSubStale(
    sub: SubState<TDescriptor, TPayload>,
    reason: StaleReason,
  ): void {
    for (const localSubscriber of sub.subscribers) {
      if (localSubscriber.freshness === "stale") {
        continue;
      }

      localSubscriber.freshness = "stale";
      localSubscriber.callbacks.onFreshnessChange("stale", reason);
    }
  }

  private notifyConnectionError(
    connection: ConnectionState<TDescriptor, TPayload>,
    error: Error,
  ): void {
    for (const sub of connection.subs.values()) {
      for (const localSubscriber of sub.subscribers) {
        localSubscriber.callbacks.onError(error);
      }
    }
  }

  private enqueueControlFrame(
    connection: ConnectionState<TDescriptor, TPayload>,
    kind: ControlFrameKind,
    entries: [string, TDescriptor][],
  ): void {
    if (entries.length === 0) {
      return;
    }

    const frame = this.findLastQueuedFrame(connection, kind);
    const target =
      frame ??
      (() => {
        const next: ControlFrame<TDescriptor> = {
          kind,
          descriptors: new Map(),
        };
        connection.controlQueue.push(next);
        return next;
      })();

    for (const [subscriptionKey, descriptor] of entries) {
      target.descriptors.set(subscriptionKey, descriptor);
    }

    this.scheduleControlFlush(connection);
  }

  private findLastQueuedFrame(
    connection: ConnectionState<TDescriptor, TPayload>,
    kind: ControlFrameKind,
  ): ControlFrame<TDescriptor> | undefined {
    for (let index = connection.controlQueue.length - 1; index >= 0; index--) {
      const frame = connection.controlQueue[index];
      if (frame?.kind === kind) {
        return frame;
      }
    }

    return undefined;
  }

  private removeQueuedDescriptor(
    connection: ConnectionState<TDescriptor, TPayload>,
    kind: ControlFrameKind,
    subscriptionKey: string,
  ): void {
    for (const frame of connection.controlQueue) {
      if (frame.kind === kind) {
        frame.descriptors.delete(subscriptionKey);
      }
    }

    for (let index = connection.controlQueue.length - 1; index >= 0; index--) {
      if (connection.controlQueue[index]?.descriptors.size === 0) {
        connection.controlQueue.splice(index, 1);
      }
    }
  }

  private scheduleControlFlush(
    connection: ConnectionState<TDescriptor, TPayload>,
  ): void {
    if (connection.controlTimer || !connection.isOpen) {
      return;
    }

    const elapsed =
      connection.lastControlSentAt === undefined
        ? this.controlFrameIntervalMs
        : this.now() - connection.lastControlSentAt;
    const delay =
      connection.lastControlSentAt === undefined
        ? 0
        : Math.max(0, this.controlFrameIntervalMs - elapsed);

    connection.controlTimer = this.setTimer(() => {
      connection.controlTimer = undefined;
      this.flushControlFrame(connection);
    }, delay);
  }

  private flushControlFrame(
    connection: ConnectionState<TDescriptor, TPayload>,
  ): void {
    if (!connection.isOpen) {
      return;
    }

    const frame = connection.controlQueue.shift();
    if (!frame) {
      return;
    }

    const descriptors = [...frame.descriptors.values()];
    if (descriptors.length > 0) {
      const data =
        frame.kind === "subscribe"
          ? this.protocol.encodeSubscribe(descriptors)
          : this.protocol.encodeUnsubscribe(descriptors);
      connection.session.send(data);
      connection.lastControlSentAt = this.now();
    }

    if (connection.controlQueue.length > 0) {
      this.scheduleControlFlush(connection);
      return;
    }

    if (connection.closeAfterControlQueueDrained) {
      this.closeConnection(connection);
    }
  }
}
