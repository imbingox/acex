type TimerHandle = ReturnType<typeof setTimeout>;

export type WebSocketFactory = (url: string) => WebSocket;

export interface ManagedWebSocketWatchdogOptions {
  staleAfterMs: number;
  onStale(staleAt: number): void;
}

export interface ManagedWebSocketReconnectOptions {
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier?: number;
}

export interface ManagedWebSocketOptions<TMessage> {
  url: string;
  initialMessageTimeoutMs: number;
  parseMessage(data: string): TMessage | undefined;
  onMessage(message: TMessage, receivedAt: number): void;
  onUnexpectedClose(event: CloseEvent): void;
  onError?(event: Event): void;
  messageWatchdog?: ManagedWebSocketWatchdogOptions;
  reconnect?: ManagedWebSocketReconnectOptions;
  now?: () => number;
  createWebSocket?: WebSocketFactory;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export interface ManagedWebSocketSession {
  readonly ready: Promise<void>;
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

  let closed = false;
  let staleNotified = false;
  let hasMessage = false;
  let lastMessageAt = now();
  let initialTimeout: TimerHandle | undefined;
  let staleTimeout: TimerHandle | undefined;
  let reconnectTimeout: TimerHandle | undefined;
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

  const scheduleStaleTimeout = () => {
    if (closed || !messageWatchdog) {
      return;
    }

    if (staleTimeout) {
      clearTimer(staleTimeout);
    }

    staleTimeout = setTimer(() => {
      if (closed || staleNotified) {
        return;
      }

      staleNotified = true;
      messageWatchdog.onStale(now());
    }, messageWatchdog.staleAfterMs);
  };

  const scheduleReconnect = () => {
    if (closed || !reconnect || !hasMessage || reconnectTimeout) {
      return;
    }

    const delay = Math.min(
      reconnect.initialDelayMs * reconnectMultiplier ** reconnectAttempts,
      reconnect.maxDelayMs,
    );
    reconnectAttempts += 1;
    reconnectTimeout = setTimer(() => {
      reconnectTimeout = undefined;
      connect();
    }, delay);
  };

  const connect = () => {
    if (closed) {
      return;
    }

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
      scheduleStaleTimeout();
    }

    socket.addEventListener("message", (event) => {
      if (closed || activeSocket !== socket || typeof event.data !== "string") {
        return;
      }

      let parsed: TMessage | undefined;
      try {
        parsed = options.parseMessage(event.data);
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

      hasMessage = true;
      staleNotified = false;
      lastMessageAt = now();
      reconnectAttempts = 0;

      if (initialTimeout) {
        clearTimer(initialTimeout);
        initialTimeout = undefined;
      }

      if (messageWatchdog) {
        scheduleStaleTimeout();
      }
      options.onMessage(parsed, lastMessageAt);
      resolveIfPending();
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
