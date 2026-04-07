import type { MarketRecord } from "../client/records.ts";
import { cloneMarketStatus } from "../client/records.ts";
import type { AcexClientImpl } from "../client/runtime.ts";
import type {
  FundingRateSnapshot,
  FundingRateUpdatedEvent,
  L1Book,
  L1BookUpdatedEvent,
  MarketDataStatus,
  MarketEventStreams,
  MarketKeyInput,
  MarketManager,
  SubscribeFundingRateInput,
  SubscribeL1BookInput,
} from "../types/index.ts";

export class MarketManagerImpl implements MarketManager {
  readonly events: MarketEventStreams;

  constructor(private readonly client: AcexClientImpl) {
    this.events = client.marketEvents();
  }

  async subscribeFundingRate(input: SubscribeFundingRateInput): Promise<void> {
    this.client.assertStarted();
    const record = this.client.getOrCreateMarketRecord(input);
    const fundingRate =
      record.fundingRate ??
      this.client.createFundingRate(
        input.exchange,
        input.symbol,
        record.fundingRate,
      );

    if (!record.fundingRateSubscribed) {
      record.fundingRateSubscribed = true;
      record.fundingRate = fundingRate;
    }

    record.status = {
      ...record.status,
      activity: "active",
      ready: true,
      freshness: "fresh",
      lastReceivedAt: fundingRate.receivedAt,
      lastReadyAt: fundingRate.updatedAt,
      inactiveSince: undefined,
    };

    const event: FundingRateUpdatedEvent = {
      type: "funding_rate.updated",
      exchange: record.exchange,
      symbol: record.symbol,
      snapshot: fundingRate,
      ts: this.client.now(),
    };

    this.client.publishMarketEvent(event);
    this.client.publishMarketStatus(record);
  }

  async subscribeL1Book(input: SubscribeL1BookInput): Promise<void> {
    this.client.assertStarted();
    const record = this.client.getOrCreateMarketRecord(input);
    const l1Book =
      record.l1Book ??
      this.client.createL1Book(input.exchange, input.symbol, record.l1Book);

    if (!record.l1BookSubscribed) {
      record.l1BookSubscribed = true;
      record.l1Book = l1Book;
    }

    record.status = {
      ...record.status,
      activity: "active",
      ready: true,
      freshness: "fresh",
      lastReceivedAt: l1Book.receivedAt,
      lastReadyAt: l1Book.updatedAt,
      inactiveSince: undefined,
    };

    const event: L1BookUpdatedEvent = {
      type: "l1_book.updated",
      exchange: record.exchange,
      symbol: record.symbol,
      snapshot: l1Book,
      ts: this.client.now(),
    };

    this.client.publishMarketEvent(event);
    this.client.publishMarketStatus(record);
  }

  async unsubscribeFundingRate(
    input: SubscribeFundingRateInput,
  ): Promise<void> {
    const record = this.client.getMarketRecord(input);
    if (!record?.fundingRateSubscribed) {
      return;
    }

    record.fundingRateSubscribed = false;
    this.updateMarketActivity(record);
  }

  async unsubscribeL1Book(input: SubscribeL1BookInput): Promise<void> {
    const record = this.client.getMarketRecord(input);
    if (!record?.l1BookSubscribed) {
      return;
    }

    record.l1BookSubscribed = false;
    this.updateMarketActivity(record);
  }

  getFundingRate(key: MarketKeyInput): FundingRateSnapshot | undefined {
    return this.client.getMarketRecord(key)?.fundingRate;
  }

  getL1Book(key: MarketKeyInput): L1Book | undefined {
    return this.client.getMarketRecord(key)?.l1Book;
  }

  getMarketStatus(key: MarketKeyInput): MarketDataStatus | undefined {
    const status = this.client.getMarketRecord(key)?.status;
    return status ? cloneMarketStatus(status) : undefined;
  }

  private updateMarketActivity(record: MarketRecord): void {
    if (record.l1BookSubscribed || record.fundingRateSubscribed) {
      record.status = {
        ...record.status,
        activity: "active",
        inactiveSince: undefined,
      };
    } else {
      record.status = {
        ...record.status,
        activity: "inactive",
        inactiveSince: this.client.now(),
      };
    }

    this.client.publishMarketStatus(record);
  }
}
