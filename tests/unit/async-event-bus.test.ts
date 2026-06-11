import { expect, test } from "bun:test";
import { AsyncEventBus } from "../../src/internal/async-event-bus.ts";
import { expectPending } from "../support/test-utils.ts";

interface TestEvent {
  key: string;
  seq: number;
}

function event(key: string, seq: number): TestEvent {
  return { key, seq };
}

test("conflate keeps only the latest event for the same key", async () => {
  const bus = new AsyncEventBus<TestEvent>();
  const iterator = bus
    .stream(() => true, {
      mode: "conflate",
      conflateKey: (value) => value.key,
    })
    [Symbol.asyncIterator]();

  for (let seq = 0; seq < 1_000; seq += 1) {
    bus.publish(event("BTC/USDT", seq));
  }

  await expect(iterator.next()).resolves.toEqual({
    done: false,
    value: event("BTC/USDT", 999),
  });
  await expectPending(iterator.next());
  await iterator.return?.();
});

test("conflate keeps one latest event per key and preserves insertion order", async () => {
  const bus = new AsyncEventBus<TestEvent>();
  const iterator = bus
    .stream(() => true, {
      mode: "conflate",
      conflateKey: (value) => value.key,
    })
    [Symbol.asyncIterator]();

  bus.publish(event("BTC/USDT", 1));
  bus.publish(event("ETH/USDT", 1));
  bus.publish(event("BTC/USDT", 2));
  bus.publish(event("SOL/USDT", 1));
  bus.publish(event("ETH/USDT", 2));

  await expect(iterator.next()).resolves.toEqual({
    done: false,
    value: event("BTC/USDT", 2),
  });
  await expect(iterator.next()).resolves.toEqual({
    done: false,
    value: event("ETH/USDT", 2),
  });
  await expect(iterator.next()).resolves.toEqual({
    done: false,
    value: event("SOL/USDT", 1),
  });
  await iterator.return?.();
});

test("buffer drops oldest events and reports overflow once per backlog episode", async () => {
  const bus = new AsyncEventBus<TestEvent>();
  const overflowMaxBuffers: number[] = [];
  const iterator = bus
    .stream(() => true, {
      maxBuffer: 2,
      onOverflow: ({ maxBuffer }) => {
        overflowMaxBuffers.push(maxBuffer);
      },
    })
    [Symbol.asyncIterator]();

  bus.publish(event("BTC/USDT", 1));
  bus.publish(event("BTC/USDT", 2));
  bus.publish(event("BTC/USDT", 3));
  bus.publish(event("BTC/USDT", 4));

  expect(overflowMaxBuffers).toEqual([2]);
  await expect(iterator.next()).resolves.toEqual({
    done: false,
    value: event("BTC/USDT", 3),
  });
  await expect(iterator.next()).resolves.toEqual({
    done: false,
    value: event("BTC/USDT", 4),
  });

  bus.publish(event("BTC/USDT", 5));
  bus.publish(event("BTC/USDT", 6));
  bus.publish(event("BTC/USDT", 7));

  expect(overflowMaxBuffers).toEqual([2, 2]);
  await expect(iterator.next()).resolves.toEqual({
    done: false,
    value: event("BTC/USDT", 6),
  });
  await expect(iterator.next()).resolves.toEqual({
    done: false,
    value: event("BTC/USDT", 7),
  });
  await iterator.return?.();
});

test("pending consumers receive direct hand-off in buffer and conflate modes", async () => {
  for (const mode of ["buffer", "conflate"] as const) {
    const bus = new AsyncEventBus<TestEvent>();
    const iterator = bus
      .stream(() => true, {
        mode,
        maxBuffer: 1,
        conflateKey: (value) => value.key,
      })
      [Symbol.asyncIterator]();
    const pending = iterator.next();

    bus.publish(event("BTC/USDT", 1));

    await expect(pending).resolves.toEqual({
      done: false,
      value: event("BTC/USDT", 1),
    });

    bus.publish(event("BTC/USDT", 2));
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: event("BTC/USDT", 2),
    });
    await iterator.return?.();
  }
});

test("close resolves pending consumers and ends future reads", async () => {
  const bus = new AsyncEventBus<TestEvent>();
  const iterator = bus.stream()[Symbol.asyncIterator]();
  const pending = iterator.next();

  bus.close();
  bus.publish(event("BTC/USDT", 1));

  await expect(pending).resolves.toEqual({
    done: true,
    value: undefined,
  });
  await expect(iterator.next()).resolves.toEqual({
    done: true,
    value: undefined,
  });
});
