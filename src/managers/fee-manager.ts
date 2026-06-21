import type { RawSymbolFeeRate } from "../adapters/types.ts";
import type {
  AccountAwareManager,
  ClientContext,
  ManagerLifecycle,
} from "../client/context.ts";
import { hasPrivateCredentials } from "../client/context.ts";
import type { AcexErrorDetails } from "../errors.ts";
import {
  AcexError,
  buildAcexErrorDetails,
  formatAcexErrorMessage,
} from "../errors.ts";
import { toCanonical } from "../internal/decimal.ts";
import type {
  FeeManager,
  FeeRatePair,
  FeeRuntimeOptions,
  GetSymbolFeeRateInput,
  MarketType,
  SubscribeFeeRatesInput,
  SymbolFeeRate,
  UnsubscribeFeeRatesInput,
  Venue,
} from "../types/index.ts";

const DEFAULT_FEE_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FEE_REFRESH_REQUEST_SPACING_MS = 3_000;
const DEFAULT_FEE_REFRESH_RETRY_DELAY_MS = 60_000;
const DEFAULT_MARKET_TYPE: MarketType = "swap";

const BINANCE_DEFAULT_RATES: Record<MarketType, FeeRatePair> = {
  spot: { maker: "0.001", taker: "0.001" },
  swap: { maker: "0.0002", taker: "0.0005" },
  future: { maker: "0.0001", taker: "0.0005" },
  option: { maker: "0.0003", taker: "0.0003" },
};

const GENERIC_DEFAULT_RATES: Record<MarketType, FeeRatePair> = {
  spot: { maker: "0.001", taker: "0.001" },
  swap: { maker: "0.0002", taker: "0.0005" },
  future: { maker: "0.0002", taker: "0.0005" },
  option: { maker: "0.0003", taker: "0.0003" },
};

const VENUE_DEFAULT_RATES: Partial<
  Record<Venue, Record<MarketType, FeeRatePair>>
> = {
  binance: BINANCE_DEFAULT_RATES,
};

interface FeeRecord {
  accountId: string;
  venue: Venue;
  symbol: string;
  marketType: MarketType;
  source: SymbolFeeRate["source"];
  maker?: string;
  taker?: string;
  receivedAt: number;
  nextRefreshAt?: number;
  generation: number;
}

interface FetchMetadata {
  accountId: string;
  venue: Venue;
  symbol: string;
}

type VenueGatePriority = "public" | "background";

interface VenueGateJob {
  priority: VenueGatePriority;
  operation: () => Promise<unknown>;
  beforeRequest?: () => boolean;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface VenueGateState {
  queue: VenueGateJob[];
  running: boolean;
  lastStartedAt?: number;
  timer?: ReturnType<typeof setTimeout>;
  scheduledJob?: VenueGateJob;
}

interface VenueGateOptions {
  priority: VenueGatePriority;
  beforeRequest?: () => boolean;
}

class StaleFeeRefreshError extends Error {
  constructor() {
    super("Stale fee refresh skipped");
    this.name = "StaleFeeRefreshError";
  }
}

function feeKey(accountId: string, symbol: string): string {
  return JSON.stringify([accountId, symbol]);
}

function uniqueSymbols(symbols: string[]): string[] {
  return [...new Set(symbols)];
}

function normalizeRefreshIntervalMs(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_FEE_REFRESH_INTERVAL_MS;
  }

  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_FEE_REFRESH_INTERVAL_MS;
}

function normalizeDefaultRates(
  input: FeeRuntimeOptions["defaultRates"],
): FeeRuntimeOptions["defaultRates"] {
  if (!input) {
    return undefined;
  }

  const output: NonNullable<FeeRuntimeOptions["defaultRates"]> = {};
  for (const [venue, marketRates] of Object.entries(input) as Array<
    [Venue, Partial<Record<MarketType, FeeRatePair>> | undefined]
  >) {
    if (!marketRates) {
      continue;
    }

    const normalizedMarketRates: Partial<Record<MarketType, FeeRatePair>> = {};
    for (const [marketType, rate] of Object.entries(marketRates) as Array<
      [MarketType, FeeRatePair | undefined]
    >) {
      if (!rate) {
        continue;
      }

      normalizedMarketRates[marketType] = {
        maker: toCanonical(rate.maker),
        taker: toCanonical(rate.taker),
      };
    }

    output[venue] = normalizedMarketRates;
  }

  return output;
}

export class FeeManagerImpl
  implements FeeManager, ManagerLifecycle, AccountAwareManager
{
  private readonly context: ClientContext;
  private readonly refreshIntervalMs: number;
  private readonly configuredDefaultRates: FeeRuntimeOptions["defaultRates"];
  private readonly records = new Map<string, FeeRecord>();
  private readonly accountGenerations = new Map<string, number>();
  private readonly venueGates = new Map<Venue, VenueGateState>();

  private started = false;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshTimerAt: number | undefined;
  private workerActive = false;

  constructor(context: ClientContext, options: FeeRuntimeOptions = {}) {
    this.context = context;
    this.refreshIntervalMs = normalizeRefreshIntervalMs(
      options.refreshIntervalMs,
    );
    this.configuredDefaultRates = normalizeDefaultRates(options.defaultRates);
  }

  async subscribe(input: SubscribeFeeRatesInput): Promise<void> {
    this.context.assertStarted();
    const account = this.context.getRegisteredAccount(input.accountId);
    const now = this.context.now();

    for (const symbol of uniqueSymbols(input.symbols)) {
      const record = this.getOrCreateRecord(
        account.accountId,
        account.venue,
        symbol,
        now,
      );
      this.refreshMarketType(record, now);
      this.enqueueForRefresh(record, now);
    }

    this.scheduleWorker();
  }

  async unsubscribe(input: UnsubscribeFeeRatesInput): Promise<void> {
    this.context.getRegisteredAccount(input.accountId);

    if (input.symbols === undefined) {
      for (const [key, record] of [...this.records.entries()]) {
        if (record.accountId === input.accountId) {
          this.records.delete(key);
        }
      }
      this.scheduleWorker();
      return;
    }

    for (const symbol of uniqueSymbols(input.symbols)) {
      this.records.delete(feeKey(input.accountId, symbol));
    }
    this.scheduleWorker();
  }

  getSymbolFeeRate(input: GetSymbolFeeRateInput): SymbolFeeRate {
    const account = this.context.getRegisteredAccount(input.accountId);
    const now = this.context.now();
    const record = this.getOrCreateRecord(
      account.accountId,
      account.venue,
      input.symbol,
      now,
    );
    this.refreshMarketType(record, now);
    this.enqueueForRefresh(record, now);
    this.scheduleWorker();
    return this.toSymbolFeeRate(record);
  }

  getSymbolFeeRates(accountId?: string): SymbolFeeRate[] {
    if (accountId !== undefined) {
      this.context.getRegisteredAccount(accountId);
    }

    return [...this.records.values()]
      .filter(
        (record) => accountId === undefined || record.accountId === accountId,
      )
      .sort((left, right) => {
        const accountComparison = left.accountId.localeCompare(right.accountId);
        if (accountComparison !== 0) {
          return accountComparison;
        }

        const venueComparison = left.venue.localeCompare(right.venue);
        return venueComparison !== 0
          ? venueComparison
          : left.symbol.localeCompare(right.symbol);
      })
      .map((record) => this.toSymbolFeeRate(record));
  }

  async fetchSymbolFeeRate(
    input: GetSymbolFeeRateInput,
  ): Promise<SymbolFeeRate> {
    this.context.assertStarted();
    const account = this.context.getRegisteredAccount(input.accountId);
    const now = this.context.now();
    const record = this.getOrCreateRecord(
      account.accountId,
      account.venue,
      input.symbol,
      now,
    );
    this.refreshMarketType(record, now);

    if (!this.supportsRemoteFetch(record)) {
      throw this.createError(
        "VENUE_NOT_SUPPORTED",
        `Venue does not support symbol fee rate queries for ${record.marketType}: ${record.venue}`,
        {
          accountId: record.accountId,
          venue: record.venue,
          symbol: record.symbol,
        },
      );
    }

    const generation = record.generation;
    try {
      const raw = await this.runWithVenueGate(
        record.venue,
        () => this.context.fetchSymbolFeeRate(input),
        { priority: "public" },
      );
      this.applyRawFeeRate(record, raw, generation, this.context.now());
      this.scheduleWorker();
      return this.toFetchedSymbolFeeRate(record, raw);
    } catch (error) {
      throw this.wrapFetchError(error, {
        accountId: record.accountId,
        venue: record.venue,
        symbol: record.symbol,
      });
    }
  }

  onClientStarted(): void {
    this.started = true;
    this.scheduleWorker();
  }

  onClientStopping(_now: number): void {
    this.started = false;
    this.clearTimer();
    this.cancelQueuedBackgroundGateJobs();
  }

  onAccountRemoved(accountId: string, _now: number): void {
    this.accountGenerations.set(
      accountId,
      this.currentGeneration(accountId) + 1,
    );
    for (const [key, record] of [...this.records.entries()]) {
      if (record.accountId === accountId) {
        this.records.delete(key);
      }
    }
    this.scheduleWorker();
  }

  onCredentialsUpdated(accountId: string, _venue: Venue): void {
    const generation = this.currentGeneration(accountId) + 1;
    this.accountGenerations.set(accountId, generation);
    const now = this.context.now();

    for (const record of this.records.values()) {
      if (record.accountId !== accountId) {
        continue;
      }

      record.generation = generation;
      if (record.source === "venue") {
        record.source = "default";
        record.maker = undefined;
        record.taker = undefined;
        record.receivedAt = now;
      }
      this.enqueueForRefresh(record, now, { force: true });
    }

    this.scheduleWorker();
  }

  private getOrCreateRecord(
    accountId: string,
    venue: Venue,
    symbol: string,
    now: number,
  ): FeeRecord {
    const key = feeKey(accountId, symbol);
    const existing = this.records.get(key);
    if (existing) {
      return existing;
    }

    const record: FeeRecord = {
      accountId,
      venue,
      symbol,
      marketType: this.resolveMarketType(venue, symbol),
      source: "default",
      receivedAt: now,
      generation: this.currentGeneration(accountId),
    };
    this.records.set(key, record);
    return record;
  }

  private refreshMarketType(record: FeeRecord, now: number): void {
    const nextMarketType = this.resolveMarketType(record.venue, record.symbol);
    if (record.marketType === nextMarketType) {
      return;
    }

    record.marketType = nextMarketType;
    record.receivedAt = now;
    if (record.source === "venue") {
      record.source = "default";
      record.maker = undefined;
      record.taker = undefined;
    }
  }

  private resolveMarketType(venue: Venue, symbol: string): MarketType {
    return (
      this.context.getMarketDefinition(venue, symbol)?.type ??
      DEFAULT_MARKET_TYPE
    );
  }

  private currentGeneration(accountId: string): number {
    return this.accountGenerations.get(accountId) ?? 0;
  }

  private enqueueForRefresh(
    record: FeeRecord,
    dueAt: number,
    options: { force?: boolean } = {},
  ): void {
    if (!this.supportsRemoteFetch(record)) {
      record.nextRefreshAt = undefined;
      return;
    }

    if (
      options.force ||
      record.nextRefreshAt === undefined ||
      dueAt < record.nextRefreshAt
    ) {
      record.nextRefreshAt = dueAt;
    }
  }

  private supportsRemoteFetch(record: FeeRecord): boolean {
    return (
      record.venue === "binance" &&
      record.marketType === "swap" &&
      this.context.getPrivateOrderCapabilities(record.venue)?.fees ===
        "supported"
    );
  }

  private scheduleWorker(): void {
    if (!this.started || this.workerActive) {
      return;
    }

    const next = this.findNextRefreshRecord();
    if (!next || next.nextRefreshAt === undefined) {
      this.clearTimer();
      return;
    }

    const now = this.context.now();
    const delay = Math.max(0, next.nextRefreshAt - now);
    const timerAt = now + delay;
    if (
      this.refreshTimer &&
      this.refreshTimerAt !== undefined &&
      this.refreshTimerAt <= timerAt
    ) {
      return;
    }

    this.clearTimer();
    this.refreshTimerAt = timerAt;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refreshTimerAt = undefined;
      void this.runWorkerOnce();
    }, delay);
  }

  private clearTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
      this.refreshTimerAt = undefined;
    }
  }

  private findNextRefreshRecord(): FeeRecord | undefined {
    let next: FeeRecord | undefined;
    for (const record of this.records.values()) {
      if (
        record.nextRefreshAt === undefined ||
        !this.supportsRemoteFetch(record)
      ) {
        continue;
      }

      if (
        !next ||
        (next.nextRefreshAt !== undefined &&
          record.nextRefreshAt < next.nextRefreshAt)
      ) {
        next = record;
      }
    }

    return next;
  }

  private async runWorkerOnce(): Promise<void> {
    if (!this.started || this.workerActive) {
      return;
    }

    const record = this.findNextRefreshRecord();
    if (
      !record ||
      record.nextRefreshAt === undefined ||
      record.nextRefreshAt > this.context.now()
    ) {
      this.scheduleWorker();
      return;
    }

    this.workerActive = true;
    try {
      await this.refreshRecord(record);
    } finally {
      this.workerActive = false;
      this.scheduleWorker();
    }
  }

  private async refreshRecord(record: FeeRecord): Promise<void> {
    const generation = record.generation;
    const metadata: FetchMetadata = {
      accountId: record.accountId,
      venue: record.venue,
      symbol: record.symbol,
    };

    try {
      const raw = await this.runWithVenueGate(
        record.venue,
        () =>
          this.fetchBackgroundSymbolFeeRate({
            accountId: record.accountId,
            venue: record.venue,
            symbol: record.symbol,
          }),
        {
          priority: "background",
          beforeRequest: () =>
            this.canRequestBackgroundRefresh(record, generation),
        },
      );
      if (!this.canUseBackgroundResult(record, generation)) {
        return;
      }

      this.applyRawFeeRate(record, raw, generation, this.context.now());
    } catch (error) {
      if (error instanceof StaleFeeRefreshError) {
        return;
      }

      if (!this.canUseBackgroundResult(record, generation)) {
        return;
      }

      this.handleBackgroundFetchError(error, metadata);
      this.rescheduleAfterFailure(record, generation, this.context.now());
    }
  }

  private fetchBackgroundSymbolFeeRate(
    metadata: FetchMetadata,
  ): Promise<RawSymbolFeeRate> {
    const account = this.context.getRegisteredAccount(metadata.accountId);
    if (!hasPrivateCredentials(account.credentials)) {
      throw this.createUnpublishedError(
        "CREDENTIALS_MISSING",
        `Account credentials are required for symbol fee rate queries: ${metadata.accountId}`,
        metadata,
      );
    }

    return this.context.fetchSymbolFeeRate({
      accountId: metadata.accountId,
      symbol: metadata.symbol,
    });
  }

  private async runWithVenueGate<T>(
    venue: Venue,
    operation: () => Promise<T>,
    options: VenueGateOptions,
  ): Promise<T> {
    const state = this.getVenueGateState(venue);

    return await new Promise<T>((resolve, reject) => {
      const job: VenueGateJob = {
        priority: options.priority,
        operation,
        beforeRequest: options.beforeRequest,
        resolve: (value) => resolve(value as T),
        reject,
      };

      if (job.priority === "public") {
        this.preemptScheduledBackgroundJob(state);
      }

      state.queue.push(job);
      this.pumpVenueGate(venue, state);
    });
  }

  private getVenueGateState(venue: Venue): VenueGateState {
    const existing = this.venueGates.get(venue);
    if (existing) {
      return existing;
    }

    const state: VenueGateState = {
      queue: [],
      running: false,
    };
    this.venueGates.set(venue, state);
    return state;
  }

  private preemptScheduledBackgroundJob(state: VenueGateState): void {
    const scheduledJob = state.scheduledJob;
    if (!scheduledJob || scheduledJob.priority !== "background") {
      return;
    }

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }

    state.scheduledJob = undefined;
    state.queue.unshift(scheduledJob);
  }

  private pumpVenueGate(venue: Venue, state: VenueGateState): void {
    if (state.running || state.timer) {
      return;
    }

    while (true) {
      const job = this.takeNextVenueGateJob(state);
      if (!job) {
        return;
      }

      if (!this.canRunGateJob(job)) {
        job.reject(new StaleFeeRefreshError());
        continue;
      }

      const waitMs = this.getVenueGateWaitMs(state);
      if (waitMs > 0) {
        state.scheduledJob = job;
        state.timer = setTimeout(() => {
          state.timer = undefined;
          const scheduledJob = state.scheduledJob;
          state.scheduledJob = undefined;
          if (scheduledJob) {
            this.executeVenueGateJob(venue, state, scheduledJob);
          }
        }, waitMs);
        return;
      }

      this.executeVenueGateJob(venue, state, job);
      return;
    }
  }

  private takeNextVenueGateJob(
    state: VenueGateState,
  ): VenueGateJob | undefined {
    const publicIndex = state.queue.findIndex(
      (job) => job.priority === "public",
    );
    if (publicIndex >= 0) {
      return state.queue.splice(publicIndex, 1)[0];
    }

    return state.queue.shift();
  }

  private getVenueGateWaitMs(state: VenueGateState): number {
    if (state.lastStartedAt === undefined) {
      return 0;
    }

    return Math.max(
      0,
      state.lastStartedAt +
        DEFAULT_FEE_REFRESH_REQUEST_SPACING_MS -
        this.context.now(),
    );
  }

  private executeVenueGateJob(
    venue: Venue,
    state: VenueGateState,
    job: VenueGateJob,
  ): void {
    if (!this.canRunGateJob(job)) {
      job.reject(new StaleFeeRefreshError());
      this.pumpVenueGate(venue, state);
      return;
    }

    state.running = true;
    state.lastStartedAt = this.context.now();
    let result: Promise<unknown>;
    try {
      result = job.operation();
    } catch (error) {
      job.reject(error);
      state.running = false;
      this.pumpVenueGate(venue, state);
      return;
    }

    result.then(job.resolve, job.reject).finally(() => {
      state.running = false;
      this.pumpVenueGate(venue, state);
    });
  }

  private canRunGateJob(job: VenueGateJob): boolean {
    return job.beforeRequest?.() ?? true;
  }

  private cancelQueuedBackgroundGateJobs(): void {
    for (const [venue, state] of this.venueGates.entries()) {
      if (state.scheduledJob?.priority === "background") {
        if (state.timer) {
          clearTimeout(state.timer);
          state.timer = undefined;
        }
        state.scheduledJob.reject(new StaleFeeRefreshError());
        state.scheduledJob = undefined;
      }

      const remainingQueue: VenueGateJob[] = [];
      for (const job of state.queue) {
        if (job.priority === "background") {
          job.reject(new StaleFeeRefreshError());
          continue;
        }
        remainingQueue.push(job);
      }
      state.queue = remainingQueue;

      this.pumpVenueGate(venue, state);
    }
  }

  private canRequestBackgroundRefresh(
    record: FeeRecord,
    generation: number,
  ): boolean {
    if (!this.isCurrentRecord(record, generation)) {
      return false;
    }

    const now = this.context.now();
    this.refreshMarketType(record, now);
    if (!this.supportsRemoteFetch(record)) {
      record.nextRefreshAt = undefined;
      return false;
    }

    return record.nextRefreshAt !== undefined && record.nextRefreshAt <= now;
  }

  private canUseBackgroundResult(
    record: FeeRecord,
    generation: number,
  ): boolean {
    if (!this.isCurrentRecord(record, generation)) {
      return false;
    }

    this.refreshMarketType(record, this.context.now());
    if (!this.supportsRemoteFetch(record)) {
      record.nextRefreshAt = undefined;
      return false;
    }

    return true;
  }

  private applyRawFeeRate(
    record: FeeRecord,
    raw: RawSymbolFeeRate,
    generation: number,
    now: number,
  ): void {
    if (!this.canApply(record, generation)) {
      return;
    }

    record.source = "venue";
    record.maker = toCanonical(raw.maker);
    record.taker = toCanonical(raw.taker);
    record.receivedAt = raw.receivedAt;
    record.nextRefreshAt = now + this.refreshIntervalMs;
  }

  private canApply(record: FeeRecord, generation: number): boolean {
    return this.isCurrentRecord(record, generation);
  }

  private isCurrentRecord(record: FeeRecord, generation: number): boolean {
    return (
      this.started &&
      this.records.get(feeKey(record.accountId, record.symbol)) === record &&
      record.generation === generation &&
      this.currentGeneration(record.accountId) === generation
    );
  }

  private rescheduleAfterFailure(
    record: FeeRecord,
    generation: number,
    now: number,
  ): void {
    if (!this.canApply(record, generation)) {
      return;
    }

    record.nextRefreshAt =
      now +
      Math.min(this.refreshIntervalMs, DEFAULT_FEE_REFRESH_RETRY_DELAY_MS);
  }

  private handleBackgroundFetchError(
    error: unknown,
    metadata: FetchMetadata,
  ): void {
    const feeError =
      error instanceof AcexError
        ? error
        : this.createFetchError(error, metadata);
    this.context.publishRuntimeError("fee", feeError, metadata);
  }

  private wrapFetchError(error: unknown, metadata: FetchMetadata): AcexError {
    if (error instanceof AcexError) {
      return error;
    }

    this.context.publishRuntimeError(
      "adapter",
      error instanceof Error ? error : new Error("Unknown fee rate failure"),
      metadata,
    );
    return this.createFetchError(error, metadata);
  }

  private createFetchError(error: unknown, metadata: FetchMetadata): AcexError {
    const details = this.addVenueErrorReason(
      metadata.venue,
      buildAcexErrorDetails(metadata, error) ?? metadata,
    );
    return new AcexError(
      "FEE_RATE_FETCH_FAILED",
      formatAcexErrorMessage(
        `Failed to fetch symbol fee rate for ${metadata.accountId}: ${metadata.symbol}`,
        details,
      ),
      {
        cause: error,
        details,
      },
    );
  }

  private createError(
    code: "VENUE_NOT_SUPPORTED",
    message: string,
    metadata: FetchMetadata,
  ): AcexError {
    const error = new AcexError(code, message, {
      details: buildAcexErrorDetails(metadata),
    });
    this.context.publishRuntimeError("fee", error, metadata);
    return error;
  }

  private createUnpublishedError(
    code: "CREDENTIALS_MISSING",
    message: string,
    metadata: FetchMetadata,
  ): AcexError {
    return new AcexError(code, message, {
      details: buildAcexErrorDetails(metadata),
    });
  }

  private addVenueErrorReason(
    venue: Venue,
    details: AcexErrorDetails,
  ): AcexErrorDetails {
    const venueErrorCode = details.venueError?.code;
    if (!venueErrorCode) {
      return details;
    }

    const reason = this.context.normalizeVenueErrorCode(venue, venueErrorCode);
    if (!reason) {
      return details;
    }

    return {
      ...details,
      venueError: {
        ...details.venueError,
        reason,
      },
    };
  }

  private toSymbolFeeRate(record: FeeRecord): SymbolFeeRate {
    if (record.source === "venue" && record.maker && record.taker) {
      return {
        accountId: record.accountId,
        venue: record.venue,
        symbol: record.symbol,
        marketType: record.marketType,
        maker: record.maker,
        taker: record.taker,
        source: "venue",
        receivedAt: record.receivedAt,
      };
    }

    const defaultRate = this.getDefaultRate(record.venue, record.marketType);
    return {
      accountId: record.accountId,
      venue: record.venue,
      symbol: record.symbol,
      marketType: record.marketType,
      maker: defaultRate.maker,
      taker: defaultRate.taker,
      source: "default",
      receivedAt: record.receivedAt,
    };
  }

  private toFetchedSymbolFeeRate(
    record: FeeRecord,
    raw: RawSymbolFeeRate,
  ): SymbolFeeRate {
    return {
      accountId: record.accountId,
      venue: record.venue,
      symbol: raw.symbol,
      marketType: record.marketType,
      maker: toCanonical(raw.maker),
      taker: toCanonical(raw.taker),
      source: "venue",
      receivedAt: raw.receivedAt,
    };
  }

  private getDefaultRate(venue: Venue, marketType: MarketType): FeeRatePair {
    return (
      this.configuredDefaultRates?.[venue]?.[marketType] ??
      VENUE_DEFAULT_RATES[venue]?.[marketType] ??
      GENERIC_DEFAULT_RATES[marketType]
    );
  }
}
