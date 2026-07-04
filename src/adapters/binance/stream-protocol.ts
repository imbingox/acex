import type {
  EncodedVenueControlFrame,
  StreamLivenessPolicy,
  VenueControlAck,
  VenueStreamProtocol,
} from "../../internal/subscription-multiplexer.ts";
import type { BinanceMarketDefinition } from "./market-catalog.ts";

export type BinanceStreamChannel = "l1book" | "fundingRate";

export interface BinanceStreamDescriptor {
  readonly channel: BinanceStreamChannel;
  readonly market: BinanceMarketDefinition;
}

export interface BinanceStreamMessage {
  readonly result?: unknown;
  readonly id?: number | string;
  readonly code?: number;
  readonly msg?: string;
  readonly e?: string;
  readonly E?: number;
  readonly s?: string;
  readonly b?: string;
  readonly B?: string;
  readonly a?: string;
  readonly A?: string;
  readonly p?: string;
  readonly i?: string;
  readonly r?: string;
  readonly T?: number;
}

export type BinanceStreamPayload =
  | {
      readonly channel: "l1book";
      readonly bidPrice: string;
      readonly bidSize: string;
      readonly askPrice: string;
      readonly askSize: string;
      readonly exchangeTs?: number;
    }
  | {
      readonly channel: "fundingRate";
      readonly fundingRate: string;
      readonly nextFundingTime?: number;
      readonly markPrice?: string;
      readonly indexPrice?: string;
      readonly exchangeTs?: number;
    };

interface BinanceStreamProtocolOptions {
  readonly fundingRateStaleAfterMs: number;
}

const BINANCE_SPOT_WS_BASE_URL = "wss://stream.binance.com:9443/ws";
const BINANCE_USDM_WS_BASE_URL = "wss://fstream.binance.com/ws";
const BINANCE_USDM_MARKET_WS_BASE_URL = "wss://fstream.binance.com/market/ws";
const BINANCE_COINM_WS_BASE_URL = "wss://dstream.binance.com/ws";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasField(value: object, field: keyof BinanceStreamMessage): boolean {
  return Object.hasOwn(value, field);
}

function streamName(descriptor: BinanceStreamDescriptor): string {
  const channel = descriptor.channel === "l1book" ? "bookTicker" : "markPrice";
  return `${descriptor.market.id.toLowerCase()}@${channel}`;
}

function connectionKeyFor(descriptor: BinanceStreamDescriptor): string {
  switch (descriptor.market.family) {
    case "spot":
      if (descriptor.channel === "fundingRate") {
        throw new Error(
          `Funding rate is not supported for spot market: ${descriptor.market.symbol}`,
        );
      }
      return BINANCE_SPOT_WS_BASE_URL;
    case "usdm":
      return descriptor.channel === "l1book"
        ? BINANCE_USDM_WS_BASE_URL
        : BINANCE_USDM_MARKET_WS_BASE_URL;
    case "coinm":
      return BINANCE_COINM_WS_BASE_URL;
  }
}

export class BinanceStreamProtocol
  implements
    VenueStreamProtocol<
      BinanceStreamMessage,
      BinanceStreamDescriptor,
      BinanceStreamPayload
    >
{
  private nextControlFrameId = 1;

  constructor(private readonly options: BinanceStreamProtocolOptions) {}

  subscriptionKey(descriptor: BinanceStreamDescriptor): string {
    return `${descriptor.channel}:${descriptor.market.id}`;
  }

  connectionKey(descriptor: BinanceStreamDescriptor): string {
    return connectionKeyFor(descriptor);
  }

  connectionUrl(connectionKey: string): string {
    return connectionKey;
  }

  parseMessage(data: string): BinanceStreamMessage | undefined {
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
    descriptors: BinanceStreamDescriptor[],
  ): EncodedVenueControlFrame {
    return this.encodeControlFrame("SUBSCRIBE", descriptors);
  }

  encodeUnsubscribe(
    descriptors: BinanceStreamDescriptor[],
  ): EncodedVenueControlFrame {
    return this.encodeControlFrame("UNSUBSCRIBE", descriptors);
  }

  livenessPolicy(
    descriptor: BinanceStreamDescriptor,
  ): StreamLivenessPolicy | undefined {
    if (descriptor.channel !== "fundingRate") {
      return undefined;
    }

    return {
      kind: "periodic",
      staleAfterMs: this.options.fundingRateStaleAfterMs,
      onStale: "reconnect",
    };
  }

  routeMessage(message: BinanceStreamMessage):
    | {
        kind: "data";
        subscriptionKey: string;
        payload: BinanceStreamPayload;
      }
    | { kind: "ack"; ack: VenueControlAck }
    | { kind: "ignore" } {
    if (hasField(message, "result") || this.isIdOnlyAck(message)) {
      return { kind: "ack", ack: this.createAck(message) };
    }

    if (
      typeof message.s === "string" &&
      typeof message.r === "string" &&
      message.e === "markPriceUpdate"
    ) {
      return {
        kind: "data",
        subscriptionKey: `fundingRate:${message.s}`,
        payload: {
          channel: "fundingRate",
          fundingRate: message.r,
          nextFundingTime: message.T,
          markPrice: message.p,
          indexPrice: message.i,
          exchangeTs: message.E,
        },
      };
    }

    if (
      typeof message.s === "string" &&
      typeof message.b === "string" &&
      typeof message.B === "string" &&
      typeof message.a === "string" &&
      typeof message.A === "string"
    ) {
      return {
        kind: "data",
        subscriptionKey: `l1book:${message.s}`,
        payload: {
          channel: "l1book",
          bidPrice: message.b,
          bidSize: message.B,
          askPrice: message.a,
          askSize: message.A,
          exchangeTs: message.T,
        },
      };
    }

    return { kind: "ignore" };
  }

  private encodeControlFrame(
    method: "SUBSCRIBE" | "UNSUBSCRIBE",
    descriptors: BinanceStreamDescriptor[],
  ): EncodedVenueControlFrame {
    const id = this.nextControlFrameId;
    const frame = {
      method,
      params: descriptors.map(streamName),
      id,
    };
    this.nextControlFrameId += 1;
    return {
      data: JSON.stringify(frame),
      ackId: id,
    };
  }

  private isIdOnlyAck(message: BinanceStreamMessage): boolean {
    return (
      message.id !== undefined &&
      message.e === undefined &&
      message.s === undefined &&
      message.b === undefined &&
      message.a === undefined &&
      message.r === undefined
    );
  }

  private createAck(message: BinanceStreamMessage): VenueControlAck {
    if (typeof message.code === "number") {
      return {
        id: message.id,
        error: new Error(
          message.msg
            ? `Binance stream subscription failed: ${message.msg}`
            : `Binance stream subscription failed with code ${message.code}`,
        ),
      };
    }

    return { id: message.id };
  }
}
