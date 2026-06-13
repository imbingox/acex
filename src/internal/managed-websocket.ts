type TimerHandle = ReturnType<typeof setTimeout>;

export const DEFAULT_RECONNECT_JITTER_RATIO = 0.2;

export type WebSocketFactory = (url: string) => WebSocket;

export interface ManagedWebSocketWatchdogOptions {
  staleAfterMs: number;
  onStale(staleAt: number): void;
}

export interface ManagedWebSocketReconnectOptions {
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier?: number;
  /**
   * Fraction of the backoff delay applied as symmetric randomized jitter,
   * expected in the range `[0, 1]`. Each reconnect waits
   * `base ± base * jitterRatio` (uniformly distributed), so independent sockets
   * desynchronize instead of reconnecting in lockstep. Defaults to
   * {@link DEFAULT_RECONNECT_JITTER_RATIO} (`0.2` → ±20%). Values outside
   * `[0, 1]` are not validated here; the resulting delay is still clamped to
   * `[0, maxDelayMs]`.
   */
  jitterRatio?: number;
  /**
   * Injectable RNG used to compute jitter. Must return a value in `[0, 1)`
   * (same contract as `Math.random`, the default). Inject a deterministic
   * source in tests to make reconnect delays reproducible.
   */
  random?: () => number;
  reconnectWithoutMessages?: boolean;
}

export interface ManagedWebSocketHeartbeatOptions {
  intervalMs: number;
  mode?: "fixed-interval" | "idle-timeout";
  pongTimeoutMs?: number;
  frame(): string;
  isPong(raw: string): boolean;
  countAnyInboundAsActivity?: boolean;
}

export interface ManagedWebSocketOptions<TMessage> {
  url: string;
  initialMessageTimeoutMs: number;
  readyWhen?: "message" | "open";
  parseMessage(data: string): TMessage | undefined;
  onMessage(message: TMessage, receivedAt: number): void;
  onUnexpectedClose(event: CloseEvent): void;
  onOpen?(): void;
  onError?(event: Event): void;
  messageWatchdog?: ManagedWebSocketWatchdogOptions;
  reconnect?: ManagedWebSocketReconnectOptions;
  heartbeat?: ManagedWebSocketHeartbeatOptions;
  now?: () => number;
  createWebSocket?: WebSocketFactory;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export interface ManagedWebSocketSession {
  readonly ready: Promise<void>;
  send(data: string): void;
  close(): void;
}

function toError(value: unknown, fallback: string): Error {
  if (value instanceof Error) {
    return value;
  }

  return new Error(fallback);
}

export function createManagedWebSocket<TMessage>(
  options: ManagedWebSocketOptions<TMessage>,
): ManagedWebSocketSession {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const createWebSocket =
    options.createWebSocket ?? ((url: string) => new WebSocket(url));
  const messageWatchdog = options.messageWatchdog;
  const reconnect = options.reconnect;
  const reconnectMultiplier = reconnect?.backoffMultiplier ?? 2;
  const reconnectJitterRatio =
    reconnect?.jitterRatio ?? DEFAULT_RECONNECT_JITTER_RATIO;
  const reconnectRandom = reconnect?.random ?? Math.random;
  const readyWhen = options.readyWhen ?? "message";
  const heartbeat = options.heartbeat;
  const heartbeatMode = heartbeat?.mode ?? "idle-timeout";
  const heartbeatCountsAnyInbound =
    heartbeat?.countAnyInboundAsActivity ?? true;

  let closed = false;
  let staleNotified = false;
  let hasMessage = false;
  let lastMessageAt = now();
  let lastHeartbeatActivityAt = lastMessageAt;
  let initialTimeout: TimerHandle | undefined;
  let staleTimeout: TimerHandle | undefined;
  let reconnectTimeout: TimerHandle | undefined;
  let heartbeatTimeout: TimerHandle | undefined;
  let pongTimeout: TimerHandle | undefined;
  let pendingPong = false;
  let reconnectAttempts = 0;
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  let activeSocket: WebSocket | undefined;

  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const clearTimers = () => {
    if (initialTimeout) {
      clearTimer(initialTimeout);
      initialTimeout = undefined;
    }

    if (staleTimeout) {
      clearTimer(staleTimeout);
      staleTimeout = undefined;
    }

    if (heartbeatTimeout) {
      clearTimer(heartbeatTimeout);
      heartbeatTimeout = undefined;
    }

    if (pongTimeout) {
      clearTimer(pongTimeout);
      pongTimeout = undefined;
    }

    pendingPong = false;
  };

  const clearReconnectTimer = () => {
    if (reconnectTimeout) {
      clearTimer(reconnectTimeout);
      reconnectTimeout = undefined;
    }
  };

  const rejectIfPending = (error: Error) => {
    if (!resolveReady || !rejectReady) {
      return;
    }

    const reject = rejectReady;
    resolveReady = undefined;
    rejectReady = undefined;
    reject(error);
  };

  const resolveIfPending = () => {
    if (!resolveReady || !rejectReady) {
      return;
    }

    const resolve = resolveReady;
    resolveReady = undefined;
    rejectReady = undefined;
    resolve();
  };

  const scheduleStaleTimeout = (socket: WebSocket) => {
    if (closed || !messageWatchdog) {
      return;
    }

    if (staleTimeout) {
      clearTimer(staleTimeout);
    }

    staleTimeout = setTimer(() => {
      if (closed || staleNotified || activeSocket !== socket) {
        return;
      }

      staleNotified = true;
      messageWatchdog.onStale(now());
    }, messageWatchdog.staleAfterMs);
  };

  const scheduleReconnect = () => {
    if (
      closed ||
      !reconnect ||
      reconnectTimeout ||
      (!hasMessage && !reconnect.reconnectWithoutMessages)
    ) {
      return;
    }

    const baseDelay = Math.min(
      reconnect.initialDelayMs * reconnectMultiplier ** reconnectAttempts,
      reconnect.maxDelayMs,
    );
    const jitter =
      baseDelay * reconnectJitterRatio * (reconnectRandom() * 2 - 1);
    const delay = Math.min(
      reconnect.maxDelayMs,
      Math.max(0, Math.round(baseDelay + jitter)),
    );
    reconnectAttempts += 1;
    reconnectTimeout = setTimer(() => {
      reconnectTimeout = undefined;
      connect();
    }, delay);
  };

  const clearHeartbeatTimeout = () => {
    if (!heartbeatTimeout) {
      return;
    }

    clearTimer(heartbeatTimeout);
    heartbeatTimeout = undefined;
  };

  const clearPongTimeout = () => {
    if (!pongTimeout) {
      return;
    }

    clearTimer(pongTimeout);
    pongTimeout = undefined;
  };

  const schedulePongTimeout = (socket: WebSocket) => {
    if (!heartbeat || heartbeat.pongTimeoutMs === undefined) {
      return;
    }

    clearPongTimeout();
    pongTimeout = setTimer(() => {
      pongTimeout = undefined;
      if (closed || activeSocket !== socket || !pendingPong) {
        return;
      }

      socket.close(1000, "heartbeat pong timeout");
    }, heartbeat.pongTimeoutMs);
  };

  const scheduleHeartbeat = (socket: WebSocket) => {
    if (
      closed ||
      !heartbeat ||
      activeSocket !== socket ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    clearHeartbeatTimeout();
    const delay =
      heartbeatMode === "fixed-interval"
        ? heartbeat.intervalMs
        : Math.max(0, heartbeat.intervalMs - (now() - lastHeartbeatActivityAt));

    heartbeatTimeout = setTimer(() => {
      heartbeatTimeout = undefined;
      if (closed || activeSocket !== socket) {
        return;
      }

      // Lazy idle check: inbound activity only updates the timestamp, so the
      // timer re-sleeps for the remaining idle window instead of being
      // rescheduled on every message.
      if (
        heartbeatMode === "idle-timeout" &&
        now() - lastHeartbeatActivityAt < heartbeat.intervalMs
      ) {
        scheduleHeartbeat(socket);
        return;
      }

      sendHeartbeat(socket);
    }, delay);
  };

  const noteHeartbeatActivity = (socket: WebSocket, activityAt: number) => {
    if (!heartbeat || activeSocket !== socket) {
      return;
    }

    lastHeartbeatActivityAt = activityAt;
  };

  const noteConnectionActivity = (
    socket: WebSocket,
    activityAt: number,
    options: { countsAsMessage: boolean; clearInitial: boolean },
  ) => {
    if (activeSocket !== socket) {
      return;
    }

    if (options.countsAsMessage) {
      hasMessage = true;
    }
    staleNotified = false;
    lastMessageAt = activityAt;
    reconnectAttempts = 0;

    if (options.clearInitial && initialTimeout) {
      clearTimer(initialTimeout);
      initialTimeout = undefined;
    }

    if (messageWatchdog) {
      scheduleStaleTimeout(socket);
    }
  };

  const sendHeartbeat = (socket: WebSocket) => {
    if (
      closed ||
      !heartbeat ||
      activeSocket !== socket ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    if (pendingPong) {
      scheduleHeartbeat(socket);
      return;
    }

    socket.send(heartbeat.frame());
    lastHeartbeatActivityAt = now();

    if (heartbeat.pongTimeoutMs !== undefined) {
      pendingPong = true;
      schedulePongTimeout(socket);
    }

    scheduleHeartbeat(socket);
  };

  const connect = () => {
    if (closed) {
      return;
    }

    clearTimers();
    const socket = createWebSocket(options.url);
    activeSocket = socket;

    if (!hasMessage) {
      initialTimeout = setTimer(() => {
        if (closed || hasMessage || activeSocket !== socket) {
          return;
        }

        rejectIfPending(
          new Error("Timed out waiting for the first websocket message"),
        );
        socket.close(1000, "initial message timeout");
      }, options.initialMessageTimeoutMs);
    }

    if (messageWatchdog) {
      scheduleStaleTimeout(socket);
    }

    socket.addEventListener("open", () => {
      if (closed || activeSocket !== socket) {
        return;
      }

      lastHeartbeatActivityAt = now();
      options.onOpen?.();
      if (readyWhen === "open") {
        resolveIfPending();
      }
      scheduleHeartbeat(socket);
    });

    socket.addEventListener("message", (event) => {
      if (closed || activeSocket !== socket || typeof event.data !== "string") {
        return;
      }

      const raw = event.data;
      const receivedAt = now();
      if (heartbeat?.isPong(raw)) {
        pendingPong = false;
        clearPongTimeout();
        noteHeartbeatActivity(socket, receivedAt);
        noteConnectionActivity(socket, receivedAt, {
          countsAsMessage: false,
          clearInitial: false,
        });
        return;
      }

      if (heartbeat && heartbeatCountsAnyInbound) {
        noteHeartbeatActivity(socket, receivedAt);
      }

      let parsed: TMessage | undefined;
      try {
        parsed = options.parseMessage(raw);
      } catch (error) {
        options.onError?.(
          new ErrorEvent("error", {
            error: toError(error, "Failed to parse websocket message"),
          }),
        );
        return;
      }

      if (!parsed) {
        return;
      }

      noteConnectionActivity(socket, receivedAt, {
        countsAsMessage: true,
        clearInitial: true,
      });
      options.onMessage(parsed, lastMessageAt);
      if (readyWhen === "message") {
        resolveIfPending();
      }
    });

    socket.addEventListener("error", (event) => {
      if (closed || activeSocket !== socket) {
        return;
      }

      options.onError?.(event);
    });

    socket.addEventListener("close", (event) => {
      if (closed || activeSocket !== socket) {
        return;
      }

      activeSocket = undefined;
      clearTimers();

      if (!hasMessage) {
        rejectIfPending(
          toError(
            event.reason || undefined,
            "WebSocket closed before the first market update arrived",
          ),
        );
      }

      options.onUnexpectedClose(event);
      scheduleReconnect();
    });
  };

  connect();

  return {
    ready,
    send(data: string): void {
      if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) {
        return;
      }

      activeSocket.send(data);
    },
    close() {
      if (closed) {
        return;
      }

      closed = true;
      clearTimers();
      clearReconnectTimer();
      activeSocket?.close(1000, "manual close");
      activeSocket = undefined;
    },
  };
}
