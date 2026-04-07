type EventPredicate<T> = (event: T) => boolean;

interface BusListener<T> {
  close(): void;
  dispatch(event: T): void;
}

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
  ): AsyncIterable<U> {
    let closed = false;
    const queue: U[] = [];
    let pendingResolve: ((result: IteratorResult<U>) => void) | undefined;

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

        queue.push(typedEvent);
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

        const queued = queue.shift();
        if (queued !== undefined) {
          return { done: false, value: queued };
        }

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
