import BigNumber from "bignumber.js";
import { toCanonical } from "../../internal/decimal.ts";
import type {
  EncodedVenueControlFrame,
  VenueControlAck,
  VenueStreamProtocol,
} from "../../internal/subscription-multiplexer.ts";
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
  readonly bidPrice: string | null;
  readonly bidSize: string | null;
  readonly askPrice: string | null;
  readonly askSize: string | null;
  readonly exchangeTs?: number;
}

export type DeribitStreamPayload = DeribitL1BookPayload;

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

function quoteSide(
  price: unknown,
  size: unknown,
): { price: string | null; size: string | null } {
  const sidePrice = positiveDecimal(price);
  const sideSize = positiveDecimal(size);
  if (!sidePrice || !sideSize) {
    return { price: null, size: null };
  }

  return { price: sidePrice, size: sideSize };
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
      DeribitStreamPayload
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

  encodeSubscribe(
    descriptors: DeribitStreamDescriptor[],
  ): EncodedVenueControlFrame {
    return this.encodeControlFrame("public/subscribe", descriptors);
  }

  encodeUnsubscribe(
    descriptors: DeribitStreamDescriptor[],
  ): EncodedVenueControlFrame {
    return this.encodeControlFrame("public/unsubscribe", descriptors);
  }

  routeMessage(message: DeribitStreamMessage):
    | {
        kind: "data";
        subscriptionKey: string;
        payload: DeribitStreamPayload;
      }
    | { kind: "ack"; ack: VenueControlAck }
    | { kind: "ignore" } {
    if (message.id !== undefined && message.method !== "subscription") {
      return { kind: "ack", ack: this.createAck(message) };
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

    if (!isRecord(message.params.data)) {
      return { kind: "ignore" };
    }

    const key = subscriptionKey(instrumentName);
    const data = message.params.data;
    const bid = quoteSide(data.best_bid_price, data.best_bid_amount);
    const ask = quoteSide(data.best_ask_price, data.best_ask_amount);
    const payloadExchangeTs = exchangeTs(data);

    return {
      kind: "data",
      subscriptionKey: key,
      payload: {
        channel: "l1book",
        bidPrice: bid.price,
        bidSize: bid.size,
        askPrice: ask.price,
        askSize: ask.size,
        exchangeTs: payloadExchangeTs,
      },
    };
  }

  private encodeControlFrame(
    method: "public/subscribe" | "public/unsubscribe",
    descriptors: DeribitStreamDescriptor[],
  ): EncodedVenueControlFrame {
    const id = this.nextControlFrameId;
    const frame = {
      jsonrpc: "2.0",
      method,
      params: {
        channels: descriptors.map((descriptor) =>
          quoteChannel(descriptor.market.id),
        ),
      },
      id,
    };
    this.nextControlFrameId += 1;
    return {
      data: JSON.stringify(frame),
      ackId: id,
    };
  }

  private createAck(message: DeribitStreamMessage): VenueControlAck {
    if (message.error !== undefined) {
      return {
        id: message.id,
        error: new Error(
          `Deribit stream subscription failed: ${this.formatError(message.error)}`,
        ),
      };
    }

    return { id: message.id };
  }

  private formatError(error: unknown): string {
    if (isRecord(error)) {
      const message = error.message;
      if (typeof message === "string" && message.length > 0) {
        return message;
      }
    }

    if (typeof error === "string" && error.length > 0) {
      return error;
    }

    return "unknown error";
  }
}
