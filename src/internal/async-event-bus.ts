type EventPredicate<T> = (event: T) => boolean;

export type AsyncEventBusStreamMode = "buffer" | "conflate";

export interface AsyncEventBusOverflowInfo {
  maxBuffer: number;
}

export interface AsyncEventBusStreamOptions<T> {
  mode?: AsyncEventBusStreamMode;
  maxBuffer?: number;
  conflateKey?: (event: T) => string;
  onOverflow?: (info: AsyncEventBusOverflowInfo) => void;
}

interface BusListener<T> {
  close(): void;
  dispatch(event: T): void;
}

const DEFAULT_MAX_BUFFER = 10_000;

/**
 * Create an iterator result that signals the iterator is finished.
 *
 * @returns An `IteratorResult<T>` with `done` set to `true` and `value` equal to `undefined` (cast to `T`).
 */
function doneResult<T>(): IteratorResult<T> {
  return { done: true, value: undefined as T };
}

export class AsyncEventBus<T> {
  private readonly listeners = new Set<BusListener<T>>();

  publish(event: T): void {
    for (const listener of this.listeners) {
      listener.dispatch(event);
    }
  }

  stream<U extends T = T>(
    filter: ((event: T) => event is U) | EventPredicate<T> = () => true,
    options: AsyncEventBusStreamOptions<U> = {},
  ): AsyncIterable<U> {
    let closed = false;
    const mode = options.mode ?? "buffer";
    const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    const bufferQueue: U[] = [];
    const conflateQueue =
      mode === "conflate" ? new Map<string, U>() : undefined;
    let overflowNotified = false;
    let pendingResolve: ((result: IteratorResult<U>) => void) | undefined;

    if (mode === "conflate" && !options.conflateKey) {
      throw new Error("AsyncEventBus conflate mode requires conflateKey");
    }

    const resetOverflowIfDrained = () => {
      if (bufferQueue.length === 0) {
        overflowNotified = false;
      }
    };

    const enqueue = (event: U) => {
      if (conflateQueue) {
        const key = options.conflateKey?.(event);
        if (key === undefined) {
          throw new Error("AsyncEventBus conflate mode requires conflateKey");
        }
        conflateQueue.set(key, event);
        return;
      }

      bufferQueue.push(event);

      if (bufferQueue.length <= maxBuffer) {
        return;
      }

      bufferQueue.shift();
      if (!overflowNotified) {
        overflowNotified = true;
        options.onOverflow?.({ maxBuffer });
      }
    };

    const dequeue = (): U | undefined => {
      if (conflateQueue) {
        const first = conflateQueue.entries().next();
        if (first.done) {
          return undefined;
        }

        const [key, event] = first.value;
        conflateQueue.delete(key);
        return event;
      }

      const event = bufferQueue.shift();
      resetOverflowIfDrained();
      return event;
    };

    const close = () => {
      if (closed) {
        return;
      }

      closed = true;
      this.listeners.delete(listener);

      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = undefined;
        resolve(doneResult<U>());
      }
    };

    const listener: BusListener<T> = {
      close,
      dispatch: (event) => {
        if (closed || !filter(event)) {
          return;
        }

        const typedEvent = event as U;
        if (pendingResolve) {
          const resolve = pendingResolve;
          pendingResolve = undefined;
          resolve({ done: false, value: typedEvent });
          return;
        }

        enqueue(typedEvent);
      },
    };

    this.listeners.add(listener);

    const iterator: AsyncIterableIterator<U> = {
      [Symbol.asyncIterator]() {
        return iterator;
      },
      next: async () => {
        if (closed) {
          return doneResult<U>();
        }

        const queued = dequeue();
        if (queued !== undefined) {
          return { done: false, value: queued };
        }

        resetOverflowIfDrained();
        return await new Promise<IteratorResult<U>>((resolve) => {
          pendingResolve = resolve;
        });
      },
      return: async () => {
        close();
        return doneResult<U>();
      },
      throw: async (error?: unknown) => {
        close();
        throw error;
      },
    };

    return iterator;
  }

  close(): void {
    for (const listener of [...this.listeners]) {
      listener.close();
    }
  }
}
