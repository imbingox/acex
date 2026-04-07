import { expect, test } from "bun:test";
import { AcexError, createClient } from "../index.ts";

async function nextEvent<T>(
  iterator: AsyncIterator<T>,
  timeoutMs = 1000,
): Promise<T> {
  const result = (await Promise.race([
    iterator.next(),
    new Promise<IteratorResult<T>>((_, reject) => {
      const timeout = setTimeout(() => {
        clearTimeout(timeout);
        reject(new Error("Timed out waiting for event"));
      }, timeoutMs);
    }),
  ])) as IteratorResult<T>;

  if (result.done) {
    throw new Error("Event stream closed unexpectedly");
  }

  return result.value;
}

test("market subscribe is a ready barrier and unsubscribe keeps the last snapshot", async () => {
  const client = createClient();

  await client.start();
  await client.market.subscribeL1Book({
    exchange: "binance",
    symbol: "BTC/USDT:USDT",
  });

  const book = client.market.getL1Book({
    exchange: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const activeStatus = client.market.getMarketStatus({
    exchange: "binance",
    symbol: "BTC/USDT:USDT",
  });

  expect(book).toBeDefined();
  expect(activeStatus?.ready).toBe(true);
  expect(activeStatus?.activity).toBe("active");

  await client.market.unsubscribeL1Book({
    exchange: "binance",
    symbol: "BTC/USDT:USDT",
  });

  const cachedBook = client.market.getL1Book({
    exchange: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const inactiveStatus = client.market.getMarketStatus({
    exchange: "binance",
    symbol: "BTC/USDT:USDT",
  });

  expect(cachedBook).toBeDefined();
  expect(inactiveStatus?.activity).toBe("inactive");
});

test("private subscriptions validate credentials at subscribe time", async () => {
  const client = createClient();

  await client.start();
  await client.registerAccount({
    accountId: "main-binance",
    exchange: "binance",
  });

  await expect(
    client.account.subscribeAccount({
      accountId: "main-binance",
    }),
  ).rejects.toBeInstanceOf(AcexError);

  await client.updateAccountCredentials("main-binance", {
    apiKey: "key",
    secret: "secret",
  });

  await client.account.subscribeAccount({
    accountId: "main-binance",
  });

  const snapshot = client.account.getAccountSnapshot("main-binance");
  const status = client.account.getAccountStatus("main-binance");

  expect(snapshot).toBeDefined();
  expect(status?.ready).toBe(true);
  expect(status?.activity).toBe("active");
});

test("removeAccount auto-cleans active private subscriptions and caches", async () => {
  const client = createClient();

  await client.registerAccount({
    accountId: "main-binance",
    exchange: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });

  await client.start();
  await client.account.subscribeAccount({
    accountId: "main-binance",
  });
  await client.order.subscribeOrders({
    accountId: "main-binance",
  });

  await client.removeAccount("main-binance");

  expect(client.account.getAccountSnapshot("main-binance")).toBeUndefined();
  expect(client.order.getOrderStatus("main-binance")).toBeUndefined();
  expect(client.getHealth().accounts).toHaveLength(0);
  expect(client.getHealth().orders).toHaveLength(0);
});

test("manager events stream emits snapshot updates", async () => {
  const client = createClient();
  const iterator = client.market.events
    .l1BookUpdates({
      exchange: "binance",
      symbol: "BTC/USDT:USDT",
    })
    [Symbol.asyncIterator]();

  await client.start();
  await client.market.subscribeL1Book({
    exchange: "binance",
    symbol: "BTC/USDT:USDT",
  });

  const event = await nextEvent(iterator);

  expect(event.type).toBe("l1_book.updated");
  expect(event.snapshot.symbol).toBe("BTC/USDT:USDT");

  await iterator.return?.();
});
