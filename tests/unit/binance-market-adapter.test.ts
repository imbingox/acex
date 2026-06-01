import { expect, test } from "bun:test";
import { BinanceMarketAdapter } from "../../src/adapters/binance/adapter.ts";
import type { L1BookStreamCallbacks } from "../../src/adapters/types.ts";
import { installBinanceMarketInfra } from "../support/exchanges/binance.ts";

const callbacks: L1BookStreamCallbacks = {
  onUpdate(): void {},
  onFreshnessChange(): void {},
  onDisconnected(): void {},
  onError(): void {},
};

test("BinanceMarketAdapter rejects stream timing option changes after multiplexer creation", async () => {
  installBinanceMarketInfra();
  const adapter = new BinanceMarketAdapter();
  const markets = await adapter.loadMarkets();
  const market = markets.find((entry) => entry.symbol === "BTC/USDT:USDT");
  if (!market) {
    throw new Error("Expected BTC/USDT:USDT market");
  }

  const now = (): number => 1;
  const handle = adapter.createL1BookStream(market, callbacks, {
    initialMessageTimeoutMs: 1_000,
    staleAfterMs: 1_000,
    reconnectDelayMs: 10,
    reconnectMaxDelayMs: 10,
    now,
  });

  try {
    expect(() =>
      adapter.createL1BookStream(market, callbacks, {
        initialMessageTimeoutMs: 1_000,
        staleAfterMs: 1_000,
        reconnectDelayMs: 10,
        reconnectMaxDelayMs: 10,
        now: (): number => 1,
      }),
    ).toThrow("stream options differ from the active multiplexer");
  } finally {
    handle.close();
  }
});
