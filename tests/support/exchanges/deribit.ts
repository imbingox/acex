import { stopAllClientsForTests } from "../../../src/client/runtime.ts";
import { FakeWebSocket, jsonResponse, textResponse } from "../test-utils.ts";

export const DERIBIT_GET_INSTRUMENTS_URL =
  "https://www.deribit.com/api/v2/public/get_instruments";
export const DERIBIT_WS_URL = "wss://www.deribit.com/ws/api/v2";

interface DeribitControlFrame {
  readonly method?: string;
  readonly channels?: string[];
}

export const deribitFixtures = {
  instruments: {
    BTC: [
      {
        instrument_name: "BTC-21JUN26-57000-C",
        expiration_timestamp: Date.UTC(2026, 5, 21),
        strike: 5.7e4,
        option_type: "call",
        base_currency: "BTC",
        quote_currency: "BTC",
        settlement_currency: "BTC",
        counter_currency: "USD",
        contract_size: 1,
        tick_size: 0.0005,
        min_trade_amount: 0.1,
        is_active: true,
        state: "open",
        instrument_type: "reversed",
        tick_size_steps: [{ above_price: 0.2, tick_size: 0.001 }],
      },
      {
        instrument_name: "BTC-21JUN26-57000-P",
        expiration_timestamp: Date.UTC(2026, 5, 21),
        strike: 57000,
        option_type: "put",
        base_currency: "BTC",
        quote_currency: "BTC",
        settlement_currency: "BTC",
        counter_currency: "USD",
        contract_size: 1,
        tick_size: 0.0005,
        min_trade_amount: 0.1,
        is_active: true,
        state: "open",
        instrument_type: "reversed",
      },
      {
        instrument_name: "BTC-21JUN26-58000-C",
        expiration_timestamp: Date.UTC(2026, 5, 21),
        strike: 58000,
        option_type: "call",
        base_currency: "BTC",
        quote_currency: "BTC",
        settlement_currency: "BTC",
        counter_currency: "USD",
        contract_size: 1,
        tick_size: 0.0005,
        min_trade_amount: 0.1,
        is_active: true,
        state: "open",
        instrument_type: "reversed",
      },
      {
        instrument_name: "BTC-21JUN26-59000-P",
        expiration_timestamp: Date.UTC(2026, 5, 21),
        strike: 59000,
        option_type: "put",
        base_currency: "BTC",
        quote_currency: "BTC",
        settlement_currency: "BTC",
        counter_currency: "USD",
        contract_size: 1,
        tick_size: 0.0005,
        min_trade_amount: 0.1,
        is_active: true,
        state: "closed",
        instrument_type: "reversed",
      },
    ],
    ETH: [
      {
        instrument_name: "ETH-21JUN26-3000-C",
        expiration_timestamp: Date.UTC(2026, 5, 21),
        strike: 3000,
        option_type: "call",
        base_currency: "ETH",
        quote_currency: "ETH",
        settlement_currency: "ETH",
        counter_currency: "USD",
        contract_size: 1,
        tick_size: 0.0005,
        min_trade_amount: 1,
        is_active: true,
        state: "open",
        instrument_type: "reversed",
      },
      {
        instrument_name: "ETH-21JUN26-3000-P",
        expiration_timestamp: Date.UTC(2026, 5, 21),
        strike: 3000,
        option_type: "put",
        base_currency: "ETH",
        quote_currency: "ETH",
        settlement_currency: "ETH",
        counter_currency: "USD",
        contract_size: 1,
        tick_size: 0.0005,
        min_trade_amount: 1,
        is_active: true,
        state: "open",
        instrument_type: "reversed",
      },
    ],
  },
};

function parseControlFrame(frame: string): DeribitControlFrame | undefined {
  try {
    const parsed = JSON.parse(frame) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }

    const record = parsed as Record<string, unknown>;
    const params = record.params;
    const channels =
      params && typeof params === "object" && !Array.isArray(params)
        ? (params as Record<string, unknown>).channels
        : undefined;

    return {
      method: typeof record.method === "string" ? record.method : undefined,
      channels: Array.isArray(channels)
        ? channels.filter(
            (channel): channel is string => typeof channel === "string",
          )
        : undefined,
    };
  } catch {
    return undefined;
  }
}

export function deribitInstrumentsResponse(currency: string): Response {
  const instruments =
    deribitFixtures.instruments[
      currency as keyof typeof deribitFixtures.instruments
    ];

  return jsonResponse({
    jsonrpc: "2.0",
    result: instruments ?? [],
  });
}

export function installDeribitMarketInfra(options?: {
  readonly failCurrencies?: readonly string[];
}): string[] {
  stopAllClientsForTests();
  FakeWebSocket.reset();

  const requestedCurrencies: string[] = [];
  const failCurrencies = new Set(options?.failCurrencies ?? []);

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const parsed = new URL(url);
      const endpoint = `${parsed.origin}${parsed.pathname}`;

      if (endpoint !== DERIBIT_GET_INSTRUMENTS_URL) {
        throw new Error(`Unexpected fetch URL: ${url}`);
      }

      const currency = parsed.searchParams.get("currency") ?? "";
      requestedCurrencies.push(currency);
      if (failCurrencies.has(currency)) {
        return textResponse("deribit down", {
          status: 503,
          statusText: "Service Unavailable",
        });
      }

      return deribitInstrumentsResponse(currency);
    },
  });

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });

  return requestedCurrencies;
}

export async function waitForDeribitControlFrame(
  socket: FakeWebSocket,
  method: "public/subscribe" | "public/unsubscribe",
  channels: string[],
  timeoutMs = 300,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    for (const frame of socket.sentFrames) {
      const parsed = parseControlFrame(frame);
      if (
        parsed?.method === method &&
        channels.every((channel) => parsed.channels?.includes(channel))
      ) {
        return;
      }
    }

    await Bun.sleep(1);
  }

  throw new Error(
    `Timed out waiting for Deribit ${method} frame containing ${channels.join(", ")}`,
  );
}
