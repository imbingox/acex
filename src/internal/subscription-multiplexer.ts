import {
  createManagedWebSocket,
  type ManagedWebSocketSession,
  type WebSocketFactory,
} from "./managed-websocket.ts";

type TimerHandle = ReturnType<typeof setTimeout>;
type Freshness = "fresh" | "stale";
type StaleReason = "heartbeat_timeout";
type ControlFrameKind = "subscribe" | "unsubscribe";
type ControlFrameAckId = number | string;

export interface EncodedVenueControlFrame {
  readonly data: string;
  readonly ackId?: ControlFrameAckId;
}

export type VenueControlFrameEncoding = string | EncodedVenueControlFrame;

export interface VenueControlAck {
  readonly id?: ControlFrameAckId;
  readonly error?: Error;
}

export interface MultiplexerSubscriptionHandle {
  readonly ready: Promise<void>;
  close(): void;
}

export interface MultiplexedStreamCallbacks<TPayload, TStatusPayload = never> {
  onPayload(payload: TPayload, receivedAt: number): void;
  onStatus?(payload: TStatusPayload, receivedAt: number): void;
  onFreshnessChange(freshness: Freshness, reason?: StaleReason): void;
  onDisconnected(): void;
  onError(error: Error): void;
}

export interface VenueHeartbeat {
  intervalMs: number;
  mode?: "fixed-interval" | "idle-timeout";
  pongTimeoutMs?: number;
  frame(): string;
  isPong(raw: string): boolean;
  countAnyInboundAsActivity?: boolean;
}

export interface VenueStreamProtocol<
  TMessage,
  TDescriptor,
  TPayload,
  TStatusPayload = never,
> {
  heartbeat?: VenueHeartbeat;
  subscriptionKey(descriptor: TDescriptor): string;
  connectionKey(descriptor: TDescriptor): string;
  connectionUrl(connectionKey: string): string;
  parseMessage(data: string): TMessage | undefined;
  encodeSubscribe(descriptors: TDescriptor[]): VenueControlFrameEncoding;
  encodeUnsubscribe(descriptors: TDescriptor[]): VenueControlFrameEncoding;
  routeMessage(
    message: TMessage,
  ):
    | { kind: "data"; subscriptionKey: string; payload: TPayload }
    | { kind: "status"; subscriptionKey: string; payload: TStatusPayload }
    | { kind: "ack"; ack: VenueControlAck }
    | { kind: "ignore" };
}

export interface SubscriptionMultiplexerOptions<TDescriptor = unknown> {
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
  onReconnect?: (info: {
    connectionKey: string;
    descriptors: readonly TDescriptor[];
  }) => void;
}

interface Deferred {
  resolve(): void;
  reject(error: Error): void;
}

interface LocalSubscriber<TPayload, TStatusPayload> {
  readonly callbacks: MultiplexedStreamCallbacks<TPayload, TStatusPayload>;
  readonly ready: Promise<void>;
  readonly deferred: Deferred;
  readySettled: boolean;
  freshness: Freshness;
  initialTimer: TimerHandle | undefined;
}

interface SubState<TDescriptor, TPayload, TStatusPayload> {
  readonly descriptor: TDescriptor;
  readonly subscribers: Set<LocalSubscriber<TPayload, TStatusPayload>>;
  ready: boolean;
}

interface ControlFrame<TDescriptor> {
  readonly kind: ControlFrameKind;
  readonly descriptors: Map<string, TDescriptor>;
}

interface PendingControlAck<TDescriptor> {
  readonly kind: ControlFrameKind;
  readonly subscriptionKeys: string[];
  readonly descriptors: Map<string, TDescriptor>;
  readonly timer: TimerHandle | undefined;
}

interface ConnectionState<TDescriptor, TPayload, TStatusPayload> {
  readonly key: string;
  readonly url: string;
  readonly subs: Map<string, SubState<TDescriptor, TPayload, TStatusPayload>>;
  readonly controlQueue: ControlFrame<TDescriptor>[];
  readonly pendingControlAcks: Map<
    ControlFrameAckId,
    PendingControlAck<TDescriptor>
  >;
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

function normalizeControlFrameEncoding(
  encoded: VenueControlFrameEncoding,
): EncodedVenueControlFrame {
  return typeof encoded === "string" ? { data: encoded } : encoded;
}

function controlAckKey(id: ControlFrameAckId): ControlFrameAckId {
  return typeof id === "number" ? id : String(id);
}

export class SubscriptionMultiplexer<
  TMessage,
  TDescriptor,
  TPayload,
  TStatusPayload = never,
> {
  private readonly connections = new Map<
    string,
    ConnectionState<TDescriptor, TPayload, TStatusPayload>[]
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
      TPayload,
      TStatusPayload
    >,
    private readonly options: SubscriptionMultiplexerOptions<TDescriptor>,
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
    callbacks: MultiplexedStreamCallbacks<TPayload, TStatusPayload>,
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
    const localSubscriber: LocalSubscriber<TPayload, TStatusPayload> = {
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
      if (existing.ready) {
        this.resolveSubReady(localSubscriber);
      } else {
        this.scheduleInitialTimeout(
          connection,
          subscriptionKey,
          existing,
          localSubscriber,
        );
      }

      return this.createHandle(
        connection,
        subscriptionKey,
        promise,
        localSubscriber,
      );
    }

    const sub: SubState<TDescriptor, TPayload, TStatusPayload> = {
      descriptor,
      subscribers: new Set([localSubscriber]),
      ready: false,
    };

    connection.subs.set(subscriptionKey, sub);
    this.scheduleInitialTimeout(
      connection,
      subscriptionKey,
      sub,
      localSubscriber,
    );

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
    connection: ConnectionState<TDescriptor, TPayload, TStatusPayload>,
    subscriptionKey: string,
    ready: Promise<void>,
    localSubscriber: LocalSubscriber<TPayload, TStatusPayload>,
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
  ): ConnectionState<TDescriptor, TPayload, TStatusPayload> {
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
  ): ConnectionState<TDescriptor, TPayload, TStatusPayload> {
    const connection: ConnectionState<TDescriptor, TPayload, TStatusPayload> = {
      key: connectionKey,
      url: this.protocol.connectionUrl(connectionKey),
      subs: new Map(),
      controlQueue: [],
      pendingControlAcks: new Map(),
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
      heartbeat: this.protocol.heartbeat,
      now: this.now,
      createWebSocket: this.createWebSocket,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
    });
    this.addConnectionToPool(connection);

    return connection;
  }

  private hasSubscriptionCapacity(
    connection: ConnectionState<TDescriptor, TPayload, TStatusPayload>,
  ): boolean {
    return (
      this.maxSubscriptionsPerConnection === undefined ||
      connection.subs.size < this.maxSubscriptionsPerConnection
    );
  }

  private findConnectionWithSubscription(
    connectionKey: string,
    subscriptionKey: string,
  ): ConnectionState<TDescriptor, TPayload, TStatusPayload> | undefined {
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
    connection: ConnectionState<TDescriptor, TPayload, TStatusPayload>,
  ): void {
    const pool = this.connections.get(connection.key);
    if (pool) {
      pool.push(connection);
      return;
    }

    this.connections.set(connection.key, [connection]);
  }

  private removeConnectionFromPool(
    connection: ConnectionState<TDescriptor, TPayload, TStatusPayload>,
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

  private handleOpen(
    connection: ConnectionState<TDescriptor, TPayload, TStatusPayload>,
  ): void {
    connection.isOpen = true;
    connection.lastControlSentAt = undefined;

    if (connection.hasOpened) {
      this.notifyReconnect(connection);
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

  private notifyReconnect(
    connection: ConnectionState<TDescriptor, TPayload, TStatusPayload>,
  ): void {
    try {
      this.options.onReconnect?.({
        connectionKey: connection.key,
        descriptors: [...connection.subs.values()].map((sub) => sub.descriptor),
      });
    } catch {
      // Observability callbacks must not break stream recovery.
    }
  }

  private handleUnexpectedClose(
    connection: ConnectionState<TDescriptor, TPayload, TStatusPayload>,
  ): void {
    connection.isOpen = false;
    connection.lastControlSentAt = undefined;
    if (connection.controlTimer) {
      this.clearTimer(connection.controlTimer);
      connection.controlTimer = undefined;
    }
    this.clearPendingControlAcks(connection);

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
    connection: ConnectionState<TDescriptor, TPayload, TStatusPayload>,
    message: TMessage,
    receivedAt: number,
  ): void {
    const routed = this.protocol.routeMessage(message);
    if (routed.kind === "ack") {
      this.handleControlAck(connection, routed.ack);
      return;
    }

    if (routed.kind !== "data" && routed.kind !== "status") {
      return;
    }

    const sub = connection.subs.get(routed.subscriptionKey);
    if (!sub) {
      return;
    }

    if (routed.kind === "data" && !sub.ready) {
      this.markSubscriptionReady(sub);
    }

    if (sub.subscribers.size === 1) {
      const localSubscriber = sub.subscribers.values().next().value;
      if (localSubscriber) {
        if (routed.kind === "data") {
          this.deliverPayload(sub, localSubscriber, routed.payload, receivedAt);
        } else {
          this.deliverStatus(sub, localSubscriber, routed.payload, receivedAt);
        }
      }
      return;
    }

    for (const localSubscriber of [...sub.subscribers]) {
      if (routed.kind === "data") {
        this.deliverPayload(sub, localSubscriber, routed.payload, receivedAt);
      } else {
        this.deliverStatus(sub, localSubscriber, routed.payload, receivedAt);
      }
    }
  }

  private deliverPayload(
    sub: SubState<TDescriptor, TPayload, TStatusPayload>,
    localSubscriber: LocalSubscriber<TPayload, TStatusPayload>,
    payload: TPayload,
    receivedAt: number,
  ): void {
    if (!sub.subscribers.has(localSubscriber)) {
      return;
    }

    if (localSubscriber.freshness !== "fresh") {
      localSubscriber.freshness = "fresh";
      localSubscriber.callbacks.onFreshnessChange("fresh");
    }

    if (sub.subscribers.has(localSubscriber)) {
      localSubscriber.callbacks.onPayload(payload, receivedAt);
    }
  }

  private deliverStatus(
    sub: SubState<TDescriptor, TPayload, TStatusPayload>,
    localSubscriber: LocalSubscriber<TPayload, TStatusPayload>,
    payload: TStatusPayload,
    receivedAt: number,
  ): void {
    if (!sub.subscribers.has(localSubscriber)) {
      return;
    }

    localSubscriber.callbacks.onStatus?.(payload, receivedAt);
  }

  private scheduleInitialTimeout(
    connection: ConnectionState<TDescriptor, TPayload, TStatusPayload>,
    subscriptionKey: string,
    sub: SubState<TDescriptor, TPayload, TStatusPayload>,
    localSubscriber: LocalSubscriber<TPayload, TStatusPayload>,
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
          `Timed out waiting for subscription acknowledgement for ${subscriptionKey}`,
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

  private clearInitialTimer(
    localSubscriber: LocalSubscriber<TPayload, TStatusPayload>,
  ): void {
    if (!localSubscriber.initialTimer) {
      return;
    }

    this.clearTimer(localSubscriber.initialTimer);
    localSubscriber.initialTimer = undefined;
  }

  private clearSubTimers(
    sub: SubState<TDescriptor, TPayload, TStatusPayload>,
  ): void {
    for (const localSubscriber of sub.subscribers) {
      this.clearInitialTimer(localSubscriber);
    }
  }

  private resolveSubReady(
    localSubscriber: LocalSubscriber<TPayload, TStatusPayload>,
  ): void {
    if (localSubscriber.readySettled) {
      return;
    }

    localSubscriber.readySettled = true;
    localSubscriber.deferred.resolve();
  }

  private markSubscriptionReady(
    sub: SubState<TDescriptor, TPayload, TStatusPayload>,
  ): void {
    sub.ready = true;
    for (const localSubscriber of sub.subscribers) {
      this.clearInitialTimer(localSubscriber);
      this.resolveSubReady(localSubscriber);
    }
  }

  private rejectSubscriptionReady(
    sub: SubState<TDescriptor, TPayload, TStatusPayload>,
    error: Error,
  ): void {
    for (const localSubscriber of sub.subscribers) {
      this.clearInitialTimer(localSubscriber);
      if (!localSubscriber.readySettled) {
        localSubscriber.readySettled = true;
        localSubscriber.deferred.reject(error);
      }
    }
  }

  private removeSubscription(
    connection: ConnectionState<TDescriptor, TPayload, TStatusPayload>,
    subscriptionKey: string,
    sendUnsubscribe: boolean,
    localSubscriber?: LocalSubscriber<TPayload, TStatusPayload>,
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
    this.removePendingDescriptor(connection, subscriptionKey);

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

  private removeEntireSubscription(
    connection: ConnectionState<TDescriptor, TPayload, TStatusPayload>,
    subscriptionKey: string,
    sendUnsubscribe: boolean,
  ): void {
    const sub = connection.subs.get(subscriptionKey);
    if (!sub) {
      return;
    }

    connection.subs.delete(subscriptionKey);
    this.clearSubTimers(sub);
    this.removeQueuedDescriptor(connection, "subscribe", subscriptionKey);
    this.removePendingDescriptor(connection, subscriptionKey);

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
    connection: ConnectionState<TDescriptor, TPayload, TStatusPayload>,
  ): void {
    connection.closeAfterControlQueueDrained = true;
    this.removeConnectionFromPool(connection);
    this.scheduleControlFlush(connection);
  }

  private closeConnection(
    connection: ConnectionState<TDescriptor, TPayload, TStatusPayload>,
  ): void {
    if (connection.controlTimer) {
      this.clearTimer(connection.controlTimer);
      connection.controlTimer = undefined;
    }

    connection.controlQueue.length = 0;
    this.clearPendingControlAcks(connection);
    connection.session.close();
    this.removeConnectionFromPool(connection);
  }

  private markAllStale(
    connection: ConnectionState<TDescriptor, TPayload, TStatusPayload>,
    reason: StaleReason,
  ): void {
    for (const sub of connection.subs.values()) {
      for (const localSubscriber of sub.subscribers) {
        if (localSubscriber.freshness === "stale") {
          continue;
        }

        localSubscriber.freshness = "stale";
        localSubscriber.callbacks.onFreshnessChange("stale", reason);
      }
    }
  }

  private markAllStaleSilently(
    connection: ConnectionState<TDescriptor, TPayload, TStatusPayload>,
  ): void {
    for (const sub of connection.subs.values()) {
      for (const localSubscriber of sub.subscribers) {
        localSubscriber.freshness = "stale";
      }
    }
  }

  private notifyConnectionError(
    connection: ConnectionState<TDescriptor, TPayload, TStatusPayload>,
    error: Error,
  ): void {
    for (const sub of connection.subs.values()) {
      for (const localSubscriber of sub.subscribers) {
        localSubscriber.callbacks.onError(error);
      }
    }
  }

  private enqueueControlFrame(
    connection: ConnectionState<TDescriptor, TPayload, TStatusPayload>,
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
    connection: ConnectionState<TDescriptor, TPayload, TStatusPayload>,
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
    connection: ConnectionState<TDescriptor, TPayload, TStatusPayload>,
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
    connection: ConnectionState<TDescriptor, TPayload, TStatusPayload>,
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
    connection: ConnectionState<TDescriptor, TPayload, TStatusPayload>,
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
      const encoded =
        frame.kind === "subscribe"
          ? this.protocol.encodeSubscribe(descriptors)
          : this.protocol.encodeUnsubscribe(descriptors);
      const controlFrame = normalizeControlFrameEncoding(encoded);
      if (
        frame.kind === "subscribe" &&
        controlFrame.ackId !== undefined &&
        frame.descriptors.size > 0
      ) {
        const ackKey = controlAckKey(controlFrame.ackId);
        connection.pendingControlAcks.set(ackKey, {
          kind: frame.kind,
          subscriptionKeys: [...frame.descriptors.keys()],
          descriptors: new Map(frame.descriptors),
          timer: this.setTimer(() => {
            this.handleControlAckTimeout(connection, ackKey);
          }, this.options.initialMessageTimeoutMs),
        });
      }
      connection.session.send(controlFrame.data);
      connection.lastControlSentAt = this.now();

      if (frame.kind === "subscribe" && controlFrame.ackId === undefined) {
        for (const subscriptionKey of frame.descriptors.keys()) {
          const sub = connection.subs.get(subscriptionKey);
          if (sub) {
            this.markSubscriptionReady(sub);
          }
        }
      }
    }

    if (connection.controlQueue.length > 0) {
      this.scheduleControlFlush(connection);
      return;
    }

    if (connection.closeAfterControlQueueDrained) {
      this.closeConnection(connection);
    }
  }

  private handleControlAck(
    connection: ConnectionState<TDescriptor, TPayload, TStatusPayload>,
    ack: VenueControlAck,
  ): void {
    if (ack.id === undefined) {
      return;
    }

    const ackKey = controlAckKey(ack.id);
    const pending = connection.pendingControlAcks.get(ackKey);
    if (!pending) {
      return;
    }

    this.clearPendingControlAck(connection, ackKey);
    if (pending.kind !== "subscribe") {
      return;
    }

    if (ack.error) {
      for (const subscriptionKey of pending.subscriptionKeys) {
        const sub = connection.subs.get(subscriptionKey);
        if (sub) {
          if (sub.ready) {
            this.notifySubscriptionAckError(sub, ack.error);
          } else {
            this.rejectSubscriptionReady(sub, ack.error);
            this.removeEntireSubscription(connection, subscriptionKey, false);
          }
        }
      }
      return;
    }

    for (const subscriptionKey of pending.subscriptionKeys) {
      const sub = connection.subs.get(subscriptionKey);
      if (sub) {
        this.markSubscriptionReady(sub);
      }
    }
  }

  private removePendingDescriptor(
    connection: ConnectionState<TDescriptor, TPayload, TStatusPayload>,
    subscriptionKey: string,
  ): void {
    for (const [ackId, pending] of connection.pendingControlAcks) {
      if (!pending.descriptors.has(subscriptionKey)) {
        continue;
      }

      pending.descriptors.delete(subscriptionKey);
      const remainingKeys = pending.subscriptionKeys.filter(
        (key) => key !== subscriptionKey,
      );
      if (remainingKeys.length === 0) {
        this.clearPendingControlAck(connection, ackId);
        continue;
      }

      connection.pendingControlAcks.set(ackId, {
        kind: pending.kind,
        subscriptionKeys: remainingKeys,
        descriptors: pending.descriptors,
        timer: pending.timer,
      });
    }
  }

  private clearPendingControlAck(
    connection: ConnectionState<TDescriptor, TPayload, TStatusPayload>,
    ackId: ControlFrameAckId,
  ): void {
    const pending = connection.pendingControlAcks.get(ackId);
    if (pending) {
      if (pending.timer) {
        this.clearTimer(pending.timer);
      }
      connection.pendingControlAcks.delete(ackId);
    }
  }

  private clearPendingControlAcks(
    connection: ConnectionState<TDescriptor, TPayload, TStatusPayload>,
  ): void {
    for (const pending of connection.pendingControlAcks.values()) {
      if (pending.timer) {
        this.clearTimer(pending.timer);
      }
    }
    connection.pendingControlAcks.clear();
  }

  private handleControlAckTimeout(
    connection: ConnectionState<TDescriptor, TPayload, TStatusPayload>,
    ackId: ControlFrameAckId,
  ): void {
    const pending = connection.pendingControlAcks.get(ackId);
    if (!pending) {
      return;
    }

    if (pending.kind !== "subscribe") {
      this.clearPendingControlAck(connection, ackId);
      return;
    }

    const readyKeys: string[] = [];
    const readyDescriptors = new Map<string, TDescriptor>();
    for (const subscriptionKey of pending.subscriptionKeys) {
      const sub = connection.subs.get(subscriptionKey);
      if (!sub) {
        continue;
      }

      if (sub.ready) {
        readyKeys.push(subscriptionKey);
        readyDescriptors.set(subscriptionKey, sub.descriptor);
        continue;
      }

      this.rejectSubscriptionReady(
        sub,
        new Error(
          `Timed out waiting for subscription acknowledgement for ${subscriptionKey}`,
        ),
      );
      this.removeEntireSubscription(connection, subscriptionKey, false);
    }

    if (readyKeys.length === 0) {
      this.clearPendingControlAck(connection, ackId);
      return;
    }

    connection.pendingControlAcks.set(ackId, {
      kind: pending.kind,
      subscriptionKeys: readyKeys,
      descriptors: readyDescriptors,
      timer: undefined,
    });
  }

  private notifySubscriptionAckError(
    sub: SubState<TDescriptor, TPayload, TStatusPayload>,
    error: Error,
  ): void {
    for (const localSubscriber of sub.subscribers) {
      localSubscriber.callbacks.onError(error);
      localSubscriber.freshness = "stale";
      localSubscriber.callbacks.onDisconnected();
    }
  }
}
