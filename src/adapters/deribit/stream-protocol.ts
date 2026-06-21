import BigNumber from "bignumber.js";
import { toCanonical } from "../../internal/decimal.ts";
import type { VenueStreamProtocol } from "../../internal/subscription-multiplexer.ts";
import type { OptionMarketDefinition } from "../../types/index.ts";

export type DeribitStreamChannel = "l1book";

export interface DeribitStreamDescriptor {
  readonly channel: DeribitStreamChannel;
  readonly market: OptionMarketDefinition;
}

export interface DeribitStreamMessage {
  readonly jsonrpc?: string;
  readonly id?: number | string;
  readonly method?: string;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly params?: unknown;
}

export interface DeribitL1BookPayload {
  readonly channel: "l1book";
  readonly bidPrice: string;
  readonly bidSize: string;
  readonly askPrice: string;
  readonly askSize: string;
  readonly exchangeTs?: number;
}

export interface DeribitNoQuotePayload {
  readonly channel: "l1book";
  readonly reason: "no_quote";
  readonly exchangeTs?: number;
  readonly raw?: Record<string, unknown>;
}

export type DeribitStreamPayload = DeribitL1BookPayload;
export type DeribitStreamStatusPayload = DeribitNoQuotePayload;

const DERIBIT_WS_URL = "wss://www.deribit.com/ws/api/v2";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function quoteChannel(instrumentName: string): string {
  return `quote.${instrumentName}`;
}

function subscriptionKey(instrumentName: string): string {
  return `l1book:${instrumentName}`;
}

function instrumentFromQuoteChannel(channel: string): string | undefined {
  return channel.startsWith("quote.")
    ? channel.slice("quote.".length)
    : undefined;
}

function positiveDecimal(value: unknown): string | undefined {
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    !(value instanceof BigNumber)
  ) {
    return undefined;
  }

  const decimal = new BigNumber(value);
  if (!decimal.isFinite() || decimal.isLessThanOrEqualTo(0)) {
    return undefined;
  }

  return toCanonical(value);
}

function exchangeTs(data: Record<string, unknown>): number | undefined {
  const timestamp = data.timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp)
    ? timestamp
    : undefined;
}

export class DeribitStreamProtocol
  implements
    VenueStreamProtocol<
      DeribitStreamMessage,
      DeribitStreamDescriptor,
      DeribitStreamPayload,
      DeribitStreamStatusPayload
    >
{
  private nextControlFrameId = 1;

  subscriptionKey(descriptor: DeribitStreamDescriptor): string {
    return subscriptionKey(descriptor.market.id);
  }

  connectionKey(_descriptor: DeribitStreamDescriptor): string {
    return DERIBIT_WS_URL;
  }

  connectionUrl(connectionKey: string): string {
    return connectionKey;
  }

  parseMessage(data: string): DeribitStreamMessage | undefined {
    try {
      const parsed = JSON.parse(data) as unknown;
      if (!isRecord(parsed)) {
        return undefined;
      }

      return parsed;
    } catch {
      return undefined;
    }
  }

  encodeSubscribe(descriptors: DeribitStreamDescriptor[]): string {
    return this.encodeControlFrame("public/subscribe", descriptors);
  }

  encodeUnsubscribe(descriptors: DeribitStreamDescriptor[]): string {
    return this.encodeControlFrame("public/unsubscribe", descriptors);
  }

  routeMessage(message: DeribitStreamMessage):
    | {
        kind: "data";
        subscriptionKey: string;
        payload: DeribitStreamPayload;
      }
    | {
        kind: "status";
        subscriptionKey: string;
        payload: DeribitStreamStatusPayload;
      }
    | { kind: "ack" }
    | { kind: "ignore" } {
    if (message.id !== undefined && message.method !== "subscription") {
      return { kind: "ack" };
    }

    if (message.method !== "subscription" || !isRecord(message.params)) {
      return { kind: "ignore" };
    }

    const channel = message.params.channel;
    if (typeof channel !== "string") {
      return { kind: "ignore" };
    }

    const instrumentName = instrumentFromQuoteChannel(channel);
    if (!instrumentName) {
      return { kind: "ignore" };
    }

    const key = subscriptionKey(instrumentName);
    const data = isRecord(message.params.data) ? message.params.data : {};
    const bidPrice = positiveDecimal(data.best_bid_price);
    const bidSize = positiveDecimal(data.best_bid_amount);
    const askPrice = positiveDecimal(data.best_ask_price);
    const askSize = positiveDecimal(data.best_ask_amount);
    const payloadExchangeTs = exchangeTs(data);

    if (bidPrice && bidSize && askPrice && askSize) {
      return {
        kind: "data",
        subscriptionKey: key,
        payload: {
          channel: "l1book",
          bidPrice,
          bidSize,
          askPrice,
          askSize,
          exchangeTs: payloadExchangeTs,
        },
      };
    }

    return {
      kind: "status",
      subscriptionKey: key,
      payload: {
        channel: "l1book",
        reason: "no_quote",
        exchangeTs: payloadExchangeTs,
        raw: data,
      },
    };
  }

  private encodeControlFrame(
    method: "public/subscribe" | "public/unsubscribe",
    descriptors: DeribitStreamDescriptor[],
  ): string {
    const frame = {
      jsonrpc: "2.0",
      method,
      params: {
        channels: descriptors.map((descriptor) =>
          quoteChannel(descriptor.market.id),
        ),
      },
      id: this.nextControlFrameId,
    };
    this.nextControlFrameId += 1;
    return JSON.stringify(frame);
  }
}
