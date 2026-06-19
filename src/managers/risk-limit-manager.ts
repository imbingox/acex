import BigNumber from "bignumber.js";
import type {
  RawRiskLimitTier,
  RawSymbolLeverageUpdate,
  RawSymbolRiskLimit,
} from "../adapters/types.ts";
import type {
  AccountAwareManager,
  ClientContext,
  ManagerLifecycle,
} from "../client/context.ts";
import type { AcexErrorDetails } from "../errors.ts";
import {
  AcexError,
  buildAcexErrorDetails,
  formatAcexErrorMessage,
} from "../errors.ts";
import { toCanonical } from "../internal/decimal.ts";
import type {
  FetchRiskLimitsInput,
  GetSymbolRiskLimitInput,
  RiskLimitLeverageFacet,
  RiskLimitManager,
  RiskLimitTier,
  RiskLimitTiersFacet,
  SetSymbolLeverageInput,
  SymbolLeverageUpdate,
  SymbolRiskLimitSnapshot,
  Venue,
} from "../types/index.ts";
import type { RiskLimitRuntimeOptions } from "../types/shared.ts";

const DEFAULT_RISK_LIMIT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_RISK_LIMIT_REFRESH_RETRY_DELAY_MS = 60_000;
const MIN_BINANCE_LEVERAGE = 1;
const MAX_BINANCE_LEVERAGE = 125;

interface RiskLimitRecord {
  accountId: string;
  venue: Venue;
  symbol: string;
  tiers: RiskLimitTiersFacet;
  leverage: RiskLimitLeverageFacet;
  updatedAt: number;
  generation: number;
  nextRefreshAt?: number;
}

interface RiskLimitAccountState {
  accountId: string;
  venue: Venue;
  generation: number;
  nextRefreshAt?: number;
  inFlight?: RiskLimitAccountRefresh;
}

interface RiskLimitAccountRefresh {
  generation: number;
  runGeneration: number;
  promise: Promise<void>;
}

interface RiskLimitMetadata {
  accountId: string;
  venue: Venue;
  symbol?: string;
}

function riskLimitKey(accountId: string, symbol: string): string {
  return JSON.stringify([accountId, symbol]);
}

function normalizeRefreshIntervalMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_RISK_LIMIT_REFRESH_INTERVAL_MS;
}

function missingTiersFacet(): RiskLimitTiersFacet {
  return {
    source: "missing",
    stale: true,
    items: [],
  };
}

function cloneTiersFacet(facet: RiskLimitTiersFacet): RiskLimitTiersFacet {
  return {
    ...facet,
    items: facet.items.map((item) => ({ ...item })),
  };
}

function cloneLeverageFacet(
  facet: RiskLimitLeverageFacet,
): RiskLimitLeverageFacet {
  return facet.lastSet ? { lastSet: { ...facet.lastSet } } : {};
}

function canonicalOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : toCanonical(value);
}

function normalizeTier(raw: RawRiskLimitTier): RiskLimitTier {
  return {
    tier: raw.tier,
    initialLeverage: toCanonical(raw.initialLeverage),
    notionalFloor: canonicalOptional(raw.notionalFloor),
    notionalCap: canonicalOptional(raw.notionalCap),
    maintenanceMarginRatio: canonicalOptional(raw.maintenanceMarginRatio),
    cumulativeMaintenanceAmount: canonicalOptional(
      raw.cumulativeMaintenanceAmount,
    ),
  };
}

function maxInitialLeverage(items: RiskLimitTier[]): string | undefined {
  let max: BigNumber | undefined;
  for (const item of items) {
    const value = new BigNumber(item.initialLeverage);
    if (!value.isFinite()) {
      continue;
    }

    if (!max || value.isGreaterThan(max)) {
      max = value;
    }
  }

  return max ? toCanonical(max.toString(10)) : undefined;
}

function normalizeLeverageInput(leverage: string): string | undefined {
  if (leverage.trim() !== leverage || leverage.length === 0) {
    return undefined;
  }

  const value = new BigNumber(leverage);
  if (
    !value.isFinite() ||
    !value.isInteger() ||
    value.isLessThan(MIN_BINANCE_LEVERAGE) ||
    value.isGreaterThan(MAX_BINANCE_LEVERAGE)
  ) {
    return undefined;
  }

  return toCanonical(value.toString(10));
}

export class RiskLimitManagerImpl
  implements RiskLimitManager, ManagerLifecycle, AccountAwareManager
{
  private readonly context: ClientContext;
  private readonly refreshIntervalMs: number;
  private readonly records = new Map<string, RiskLimitRecord>();
  private readonly accounts = new Map<string, RiskLimitAccountState>();

  private started = false;
  private runGeneration = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshTimerAt: number | undefined;

  constructor(context: ClientContext, options: RiskLimitRuntimeOptions = {}) {
    this.context = context;
    this.refreshIntervalMs = normalizeRefreshIntervalMs(
      options.refreshIntervalMs,
    );
  }

  getSymbolRiskLimit(input: GetSymbolRiskLimitInput): SymbolRiskLimitSnapshot {
    const account = this.context.getRegisteredAccount(input.accountId);
    const now = this.context.now();
    const record = this.getOrCreateRecord(
      account.accountId,
      account.venue,
      input.symbol,
      now,
    );
    this.refreshStaleness(record, now);
    return this.toSnapshot(record);
  }

  getSymbolRiskLimits(accountId?: string): SymbolRiskLimitSnapshot[] {
    if (accountId !== undefined) {
      this.context.getRegisteredAccount(accountId);
    }

    const now = this.context.now();
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
      .map((record) => {
        this.refreshStaleness(record, now);
        return this.toSnapshot(record);
      });
  }

  async fetchSymbolRiskLimit(
    input: GetSymbolRiskLimitInput,
  ): Promise<SymbolRiskLimitSnapshot> {
    this.context.assertStarted();
    const account = this.context.getRegisteredAccount(input.accountId);
    const now = this.context.now();
    const record = this.getOrCreateRecord(
      account.accountId,
      account.venue,
      input.symbol,
      now,
    );
    return await this.fetchRecord(record, this.runGeneration);
  }

  async fetchRiskLimits(
    input: FetchRiskLimitsInput,
  ): Promise<SymbolRiskLimitSnapshot[]> {
    this.context.assertStarted();
    const account = this.context.getRegisteredAccount(input.accountId);
    const state = this.getOrCreateAccountState(
      account.accountId,
      account.venue,
      this.context.now(),
    );
    const metadata: RiskLimitMetadata = {
      accountId: account.accountId,
      venue: account.venue,
    };

    try {
      await this.refreshAccountState(state, this.runGeneration);
      return this.getSymbolRiskLimits(input.accountId).filter(
        (snapshot) => snapshot.tiers.source === "venue",
      );
    } catch (error) {
      throw this.wrapFetchError(error, metadata);
    }
  }

  async setSymbolLeverage(
    input: SetSymbolLeverageInput,
  ): Promise<SymbolLeverageUpdate> {
    this.context.assertStarted();
    const account = this.context.getRegisteredAccount(input.accountId);
    const leverage = normalizeLeverageInput(input.leverage);
    const metadata: RiskLimitMetadata = {
      accountId: account.accountId,
      venue: account.venue,
      symbol: input.symbol,
    };
    if (!leverage) {
      throw this.createInputError(
        `Invalid leverage for ${input.accountId}: ${input.symbol}`,
        metadata,
      );
    }

    const now = this.context.now();
    const record = this.getOrCreateRecord(
      account.accountId,
      account.venue,
      input.symbol,
      now,
    );
    const generation = record.generation;

    try {
      const raw = await this.setRawSymbolLeverage({
        ...input,
        leverage,
      });
      const update = this.applyRawLeverageUpdate(
        record,
        raw,
        generation,
        this.context.now(),
      );
      return update;
    } catch (error) {
      throw this.wrapLeverageError(error, metadata);
    }
  }

  onAccountRegistered(accountId: string, venue: Venue): void {
    const now = this.context.now();
    const state = this.getOrCreateAccountState(accountId, venue, now);
    state.venue = venue;
    if (state.nextRefreshAt === undefined) {
      state.nextRefreshAt = now;
    }
    this.scheduleWorker();
  }

  onClientStarted(): void {
    this.started = true;
    this.runGeneration += 1;
    const now = this.context.now();
    for (const state of this.accounts.values()) {
      if (state.nextRefreshAt === undefined) {
        state.nextRefreshAt = now;
      }
    }
    this.scheduleWorker();
  }

  onClientStopping(_now: number): void {
    this.started = false;
    this.runGeneration += 1;
    this.clearTimer();
  }

  onAccountRemoved(accountId: string, _now: number): void {
    const state = this.accounts.get(accountId);
    if (state) {
      state.generation += 1;
      this.accounts.delete(accountId);
    }
    for (const [key, record] of [...this.records.entries()]) {
      if (record.accountId === accountId) {
        this.records.delete(key);
      }
    }
    this.scheduleWorker();
  }

  onCredentialsUpdated(accountId: string, venue: Venue): void {
    const now = this.context.now();
    const state = this.getOrCreateAccountState(accountId, venue, now);
    state.generation += 1;
    state.nextRefreshAt = now;

    for (const record of this.records.values()) {
      if (record.accountId !== accountId) {
        continue;
      }

      record.generation = state.generation;
      record.tiers = missingTiersFacet();
      record.updatedAt = now;
      record.nextRefreshAt = now;
    }
    this.scheduleWorker();
  }

  private getOrCreateRecord(
    accountId: string,
    venue: Venue,
    symbol: string,
    now: number,
  ): RiskLimitRecord {
    const key = riskLimitKey(accountId, symbol);
    const existing = this.records.get(key);
    if (existing) {
      return existing;
    }

    const record: RiskLimitRecord = {
      accountId,
      venue,
      symbol,
      tiers: missingTiersFacet(),
      leverage: {},
      updatedAt: now,
      generation: this.currentGeneration(accountId, venue, now),
      nextRefreshAt: now,
    };
    this.records.set(key, record);
    return record;
  }

  private getOrCreateAccountState(
    accountId: string,
    venue: Venue,
    now: number,
  ): RiskLimitAccountState {
    const existing = this.accounts.get(accountId);
    if (existing) {
      return existing;
    }

    const state: RiskLimitAccountState = {
      accountId,
      venue,
      generation: 0,
      nextRefreshAt: now,
    };
    this.accounts.set(accountId, state);
    return state;
  }

  private currentGeneration(
    accountId: string,
    venue?: Venue,
    now = this.context.now(),
  ): number {
    const state = this.accounts.get(accountId);
    if (state) {
      return state.generation;
    }

    return venue
      ? this.getOrCreateAccountState(accountId, venue, now).generation
      : 0;
  }

  private refreshStaleness(record: RiskLimitRecord, now: number): void {
    if (
      record.tiers.source === "venue" &&
      record.nextRefreshAt !== undefined &&
      record.nextRefreshAt <= now
    ) {
      record.tiers = {
        ...record.tiers,
        stale: true,
      };
    }
  }

  private scheduleWorker(): void {
    if (!this.started) {
      this.clearTimer();
      return;
    }

    const next = this.findNextRefreshAccount();
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
    if (!this.refreshTimer) {
      return;
    }

    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.refreshTimerAt = undefined;
  }

  private findNextRefreshAccount(): RiskLimitAccountState | undefined {
    let next: RiskLimitAccountState | undefined;
    for (const state of this.accounts.values()) {
      if (
        this.hasCurrentAccountRefresh(state, this.runGeneration) ||
        state.nextRefreshAt === undefined
      ) {
        continue;
      }

      if (
        !next ||
        (next.nextRefreshAt !== undefined &&
          state.nextRefreshAt < next.nextRefreshAt)
      ) {
        next = state;
      }
    }

    return next;
  }

  private async runWorkerOnce(): Promise<void> {
    if (!this.started) {
      return;
    }

    const state = this.findNextRefreshAccount();
    if (
      !state ||
      state.nextRefreshAt === undefined ||
      state.nextRefreshAt > this.context.now()
    ) {
      this.scheduleWorker();
      return;
    }

    const runGeneration = this.runGeneration;
    try {
      await this.refreshAccountState(state, runGeneration);
    } catch (error) {
      state.nextRefreshAt =
        this.context.now() +
        Math.min(
          this.refreshIntervalMs,
          DEFAULT_RISK_LIMIT_REFRESH_RETRY_DELAY_MS,
        );
      const metadata: RiskLimitMetadata = {
        accountId: state.accountId,
        venue: state.venue,
      };
      const riskError = this.toFetchError(error, metadata);
      this.context.publishRuntimeError("runtime", riskError, metadata);
    } finally {
      this.scheduleWorker();
    }
  }

  private async fetchRecord(
    record: RiskLimitRecord,
    runGeneration: number,
  ): Promise<SymbolRiskLimitSnapshot> {
    const generation = record.generation;
    const metadata: RiskLimitMetadata = {
      accountId: record.accountId,
      venue: record.venue,
      symbol: record.symbol,
    };

    try {
      const raw = await this.fetchRawSymbolRiskLimit({
        accountId: record.accountId,
        symbol: record.symbol,
      });
      this.applyRawRiskLimit(
        record,
        raw,
        generation,
        runGeneration,
        this.context.now(),
      );
      return this.toSnapshot(record);
    } catch (error) {
      throw this.wrapFetchError(error, metadata);
    }
  }

  private async refreshAccountState(
    state: RiskLimitAccountState,
    runGeneration: number,
  ): Promise<void> {
    if (this.hasCurrentAccountRefresh(state, runGeneration)) {
      await state.inFlight.promise;
      return;
    }

    const refresh: RiskLimitAccountRefresh = {
      generation: state.generation,
      runGeneration,
      promise: this.refreshAccountStateUncached(state, runGeneration).finally(
        () => {
          if (state.inFlight === refresh) {
            state.inFlight = undefined;
          }
          this.scheduleWorker();
        },
      ),
    };
    state.inFlight = refresh;
    await refresh.promise;
  }

  private hasCurrentAccountRefresh(
    state: RiskLimitAccountState,
    runGeneration: number,
  ): state is RiskLimitAccountState & {
    inFlight: RiskLimitAccountRefresh;
  } {
    return (
      state.inFlight !== undefined &&
      state.inFlight.generation === state.generation &&
      state.inFlight.runGeneration === runGeneration
    );
  }

  private async refreshAccountStateUncached(
    state: RiskLimitAccountState,
    runGeneration: number,
  ): Promise<void> {
    const generation = state.generation;
    const rawLimits = await this.fetchRawRiskLimits({
      accountId: state.accountId,
    });
    const now = this.context.now();
    if (!this.canApplyAccount(state, generation, runGeneration)) {
      return;
    }

    state.nextRefreshAt = now + this.refreshIntervalMs;
    for (const raw of rawLimits) {
      const record = this.getOrCreateRecord(
        state.accountId,
        state.venue,
        raw.symbol,
        now,
      );
      this.applyRawRiskLimit(record, raw, generation, runGeneration, now);
    }
  }

  private applyRawRiskLimit(
    record: RiskLimitRecord,
    raw: RawSymbolRiskLimit,
    generation: number,
    runGeneration: number,
    now: number,
  ): void {
    if (!this.canApply(record, generation, runGeneration)) {
      return;
    }

    const items = raw.tiers.map(normalizeTier);
    record.tiers = {
      source: "venue",
      stale: false,
      receivedAt: raw.receivedAt,
      items,
      maxInitialLeverage: maxInitialLeverage(items),
      notionalCoefficient: canonicalOptional(raw.notionalCoefficient),
    };
    record.updatedAt = now;
    record.nextRefreshAt = now + this.refreshIntervalMs;
  }

  private fetchRawSymbolRiskLimit(
    input: GetSymbolRiskLimitInput,
  ): Promise<RawSymbolRiskLimit> {
    if (!this.context.fetchSymbolRiskLimit) {
      throw new Error("ClientContext.fetchSymbolRiskLimit is not implemented");
    }

    return this.context.fetchSymbolRiskLimit(input);
  }

  private fetchRawRiskLimits(
    input: FetchRiskLimitsInput,
  ): Promise<RawSymbolRiskLimit[]> {
    if (!this.context.fetchRiskLimits) {
      throw new Error("ClientContext.fetchRiskLimits is not implemented");
    }

    return this.context.fetchRiskLimits(input);
  }

  private setRawSymbolLeverage(
    input: SetSymbolLeverageInput,
  ): Promise<RawSymbolLeverageUpdate> {
    if (!this.context.setSymbolLeverage) {
      throw new Error("ClientContext.setSymbolLeverage is not implemented");
    }

    return this.context.setSymbolLeverage(input);
  }

  private applyRawLeverageUpdate(
    record: RiskLimitRecord,
    raw: RawSymbolLeverageUpdate,
    generation: number,
    now: number,
  ): SymbolLeverageUpdate {
    const update: SymbolLeverageUpdate = {
      accountId: record.accountId,
      venue: record.venue,
      symbol: raw.symbol,
      leverage: toCanonical(raw.leverage),
      maxNotionalValue: canonicalOptional(raw.maxNotionalValue),
      receivedAt: raw.receivedAt,
    };

    if (this.canApply(record, generation, this.runGeneration)) {
      record.leverage = {
        lastSet: update,
      };
      record.updatedAt = now;
    }

    return update;
  }

  private canApply(
    record: RiskLimitRecord,
    generation: number,
    runGeneration: number,
  ): boolean {
    return (
      this.started &&
      this.runGeneration === runGeneration &&
      this.records.get(riskLimitKey(record.accountId, record.symbol)) ===
        record &&
      record.generation === generation &&
      this.currentGeneration(record.accountId) === generation
    );
  }

  private canApplyAccount(
    state: RiskLimitAccountState,
    generation: number,
    runGeneration: number,
  ): boolean {
    return (
      this.started &&
      this.runGeneration === runGeneration &&
      this.accounts.get(state.accountId) === state &&
      state.generation === generation
    );
  }

  private wrapFetchError(
    error: unknown,
    metadata: RiskLimitMetadata,
  ): AcexError {
    if (error instanceof AcexError) {
      return error;
    }

    this.context.publishRuntimeError(
      "adapter",
      error instanceof Error ? error : new Error("Unknown risk limit failure"),
      metadata,
    );
    return this.createFetchError(error, metadata);
  }

  private toFetchError(error: unknown, metadata: RiskLimitMetadata): AcexError {
    return error instanceof AcexError
      ? error
      : this.createFetchError(error, metadata);
  }

  private wrapLeverageError(
    error: unknown,
    metadata: RiskLimitMetadata,
  ): AcexError {
    if (error instanceof AcexError) {
      return error;
    }

    this.context.publishRuntimeError(
      "adapter",
      error instanceof Error ? error : new Error("Unknown leverage failure"),
      metadata,
    );
    const details = this.addVenueErrorReason(
      metadata.venue,
      buildAcexErrorDetails(metadata, error) ?? metadata,
    );
    return new AcexError(
      "LEVERAGE_SET_FAILED",
      formatAcexErrorMessage(
        `Failed to set symbol leverage for ${metadata.accountId}: ${metadata.symbol}`,
        details,
      ),
      {
        cause: error,
        details,
      },
    );
  }

  private createFetchError(
    error: unknown,
    metadata: RiskLimitMetadata,
  ): AcexError {
    const details = this.addVenueErrorReason(
      metadata.venue,
      buildAcexErrorDetails(metadata, error) ?? metadata,
    );
    return new AcexError(
      "RISK_LIMIT_FETCH_FAILED",
      formatAcexErrorMessage(
        metadata.symbol
          ? `Failed to fetch symbol risk limit for ${metadata.accountId}: ${metadata.symbol}`
          : `Failed to fetch risk limits for ${metadata.accountId}`,
        details,
      ),
      {
        cause: error,
        details,
      },
    );
  }

  private createInputError(
    message: string,
    metadata: RiskLimitMetadata,
  ): AcexError {
    const error = new AcexError("RISK_LIMIT_INPUT_INVALID", message, {
      details: buildAcexErrorDetails(metadata),
    });
    this.context.publishRuntimeError("runtime", error, metadata);
    return error;
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

  private toSnapshot(record: RiskLimitRecord): SymbolRiskLimitSnapshot {
    return {
      accountId: record.accountId,
      venue: record.venue,
      symbol: record.symbol,
      tiers: cloneTiersFacet(record.tiers),
      leverage: cloneLeverageFacet(record.leverage),
      updatedAt: record.updatedAt,
    };
  }
}
