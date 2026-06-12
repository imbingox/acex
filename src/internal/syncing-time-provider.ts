import type { TimeProvider, VenueServerTime } from "../types/index.ts";

const DEFAULT_RESYNC_INTERVAL_MS = 300_000;
const DEFAULT_STARTUP_SAMPLES = 5;
const DEFAULT_SMOOTHING_ALPHA = 0.3;
const DEFAULT_RECV_WINDOW_MS = 5_000;
const RESYNC_DEBOUNCE_MS = 2_000;

type TimerHandle = ReturnType<typeof setTimeout>;

export type SyncingTimeProviderResyncReason =
  | "startup"
  | "periodic"
  | "requested";

export interface SyncingTimeProviderResyncEvent {
  readonly reason: SyncingTimeProviderResyncReason;
  readonly previousOffsetMs: number;
  readonly sampledOffsetMs: number;
  readonly offsetMs: number;
  readonly sample?: VenueServerTime;
}

export interface SyncingTimeProviderSampleFailedEvent {
  readonly reason: SyncingTimeProviderResyncReason;
  readonly error: unknown;
  readonly failures: number;
}

export interface SyncingTimeProviderDriftWarningEvent {
  readonly reason: Exclude<SyncingTimeProviderResyncReason, "startup">;
  readonly previousOffsetMs: number;
  readonly sampledOffsetMs: number;
  readonly offsetMs: number;
  readonly driftMs: number;
  readonly thresholdMs: number;
  readonly sample: VenueServerTime;
}

export interface SyncingTimeProviderOptions {
  readonly sample: () => Promise<VenueServerTime>;
  readonly now?: () => number;
  readonly resyncIntervalMs?: number;
  readonly startupSamples?: number;
  readonly smoothingAlpha?: number;
  readonly driftWarnMs?: number;
  readonly recvWindowMs?: number;
  readonly onResync?: (event: SyncingTimeProviderResyncEvent) => void;
  readonly onSampleFailed?: (
    event: SyncingTimeProviderSampleFailedEvent,
  ) => void;
  readonly onDriftWarning?: (
    event: SyncingTimeProviderDriftWarningEvent,
  ) => void;
}

export class SyncingTimeProvider implements TimeProvider {
  private offsetMs = 0;
  private started = false;
  private runId = 0;
  private periodicScheduleId = 0;
  private periodicTimer: TimerHandle | undefined;
  private resyncDebounceTimer: TimerHandle | undefined;
  private queue: Promise<void> = Promise.resolve();
  private startupPromise: Promise<void> | undefined;

  constructor(private readonly options: SyncingTimeProviderOptions) {}

  now(): number {
    return Math.round((this.options.now ?? Date.now)() + this.offsetMs);
  }

  start(): Promise<void> {
    if (this.started) {
      return this.startupPromise ?? Promise.resolve();
    }

    this.started = true;
    const runId = ++this.runId;
    const startupPromise = this.enqueue(async () => {
      if (!this.isActive(runId)) {
        return;
      }

      await this.runStartupSamples(runId);
      if (this.isActive(runId)) {
        this.schedulePeriodicResync(runId);
      }
    });

    this.startupPromise = startupPromise.finally(() => {
      if (this.runId === runId) {
        this.startupPromise = undefined;
      }
    });

    return this.startupPromise;
  }

  stop(): void {
    if (!this.started) {
      this.clearPeriodicTimer();
      this.clearResyncDebounceTimer();
      return;
    }

    this.started = false;
    this.runId += 1;
    this.clearPeriodicTimer();
    this.clearResyncDebounceTimer();
  }

  requestResync(): void {
    if (!this.started || this.resyncDebounceTimer) {
      return;
    }

    const runId = this.runId;
    this.cancelScheduledPeriodicResync();
    this.resyncDebounceTimer = setTimeout(() => {
      this.resyncDebounceTimer = undefined;
    }, RESYNC_DEBOUNCE_MS);

    void this.enqueue(async () => {
      await this.sampleAndApply("requested", runId);
      if (this.isActive(runId)) {
        this.schedulePeriodicResync(runId);
      }
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.catch(() => undefined).then(task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async runStartupSamples(runId: number): Promise<void> {
    const sampleCount = this.startupSamples();
    const offsets: number[] = [];
    let failures = 0;
    let lastError: unknown;

    for (let index = 0; index < sampleCount; index += 1) {
      if (!this.isActive(runId)) {
        return;
      }

      try {
        const { offsetMs } = await this.sampleOffset();
        offsets.push(offsetMs);
      } catch (error) {
        failures += 1;
        lastError = error;
      }
    }

    if (!this.isActive(runId)) {
      return;
    }

    if (offsets.length === 0) {
      const previousOffsetMs = this.offsetMs;
      this.offsetMs = 0;
      this.notifySampleFailed({
        reason: "startup",
        error:
          lastError ??
          new Error("Signing clock startup sampling produced no samples"),
        failures,
      });
      this.notifyResync({
        reason: "startup",
        previousOffsetMs,
        sampledOffsetMs: 0,
        offsetMs: this.offsetMs,
      });
      return;
    }

    const previousOffsetMs = this.offsetMs;
    const sampledOffsetMs = median(offsets);
    this.offsetMs = sampledOffsetMs;
    this.notifyResync({
      reason: "startup",
      previousOffsetMs,
      sampledOffsetMs,
      offsetMs: this.offsetMs,
    });
  }

  private async sampleAndApply(
    reason: Exclude<SyncingTimeProviderResyncReason, "startup">,
    runId: number,
  ): Promise<void> {
    if (!this.isActive(runId)) {
      return;
    }

    const previousOffsetMs = this.offsetMs;
    let sample: VenueServerTime;
    let sampledOffsetMs: number;

    try {
      const result = await this.sampleOffset();
      sample = result.sample;
      sampledOffsetMs = result.offsetMs;
    } catch (error) {
      if (this.isActive(runId)) {
        this.notifySampleFailed({
          reason,
          error,
          failures: 1,
        });
      }
      return;
    }

    if (!this.isActive(runId)) {
      return;
    }

    const offsetMs =
      reason === "periodic"
        ? this.smoothingAlpha() * sampledOffsetMs +
          (1 - this.smoothingAlpha()) * previousOffsetMs
        : sampledOffsetMs;

    this.warnIfDrift({
      reason,
      previousOffsetMs,
      sampledOffsetMs,
      offsetMs,
      sample,
    });
    this.offsetMs = offsetMs;
    this.notifyResync({
      reason,
      previousOffsetMs,
      sampledOffsetMs,
      offsetMs,
      sample,
    });
  }

  private async sampleOffset(): Promise<{
    sample: VenueServerTime;
    offsetMs: number;
  }> {
    const sample = await this.options.sample();
    if (!Number.isFinite(sample.estimatedOffsetMs)) {
      throw new Error("Server time sample missing finite estimatedOffsetMs");
    }

    return {
      sample,
      offsetMs: sample.estimatedOffsetMs,
    };
  }

  private schedulePeriodicResync(runId: number): void {
    this.clearPeriodicTimer();
    if (!this.isActive(runId)) {
      return;
    }

    const scheduleId = ++this.periodicScheduleId;
    this.periodicTimer = setTimeout(() => {
      this.periodicTimer = undefined;
      if (!this.isActive(runId) || scheduleId !== this.periodicScheduleId) {
        return;
      }

      void this.enqueuePeriodicResync(runId, scheduleId);
    }, this.resyncIntervalMs());
  }

  private async enqueuePeriodicResync(
    runId: number,
    scheduleId: number,
  ): Promise<void> {
    await this.enqueue(async () => {
      if (!this.isActive(runId) || scheduleId !== this.periodicScheduleId) {
        return;
      }

      await this.sampleAndApply("periodic", runId);
    });

    if (this.isActive(runId) && scheduleId === this.periodicScheduleId) {
      this.schedulePeriodicResync(runId);
    }
  }

  private warnIfDrift(event: {
    reason: Exclude<SyncingTimeProviderResyncReason, "startup">;
    previousOffsetMs: number;
    sampledOffsetMs: number;
    offsetMs: number;
    sample: VenueServerTime;
  }): void {
    const driftMs = Math.abs(event.sampledOffsetMs - event.previousOffsetMs);
    const thresholdMs = this.driftWarnThresholdMs();
    if (driftMs <= thresholdMs) {
      return;
    }

    this.notifyDriftWarning({
      ...event,
      driftMs,
      thresholdMs,
    });
  }

  private isActive(runId: number): boolean {
    return this.started && this.runId === runId;
  }

  private clearPeriodicTimer(): void {
    if (!this.periodicTimer) {
      return;
    }

    clearTimeout(this.periodicTimer);
    this.periodicTimer = undefined;
  }

  private cancelScheduledPeriodicResync(): void {
    this.periodicScheduleId += 1;
    this.clearPeriodicTimer();
  }

  private clearResyncDebounceTimer(): void {
    if (!this.resyncDebounceTimer) {
      return;
    }

    clearTimeout(this.resyncDebounceTimer);
    this.resyncDebounceTimer = undefined;
  }

  private resyncIntervalMs(): number {
    return positiveFiniteOr(
      this.options.resyncIntervalMs,
      DEFAULT_RESYNC_INTERVAL_MS,
    );
  }

  private startupSamples(): number {
    const value = positiveFiniteOr(
      this.options.startupSamples,
      DEFAULT_STARTUP_SAMPLES,
    );
    return Math.max(1, Math.floor(value));
  }

  private smoothingAlpha(): number {
    const value = this.options.smoothingAlpha ?? DEFAULT_SMOOTHING_ALPHA;
    if (!Number.isFinite(value) || value <= 0 || value > 1) {
      return DEFAULT_SMOOTHING_ALPHA;
    }

    return value;
  }

  private driftWarnThresholdMs(): number {
    if (
      this.options.driftWarnMs !== undefined &&
      Number.isFinite(this.options.driftWarnMs) &&
      this.options.driftWarnMs >= 0
    ) {
      return this.options.driftWarnMs;
    }

    return (
      positiveFiniteOr(this.options.recvWindowMs, DEFAULT_RECV_WINDOW_MS) / 2
    );
  }

  private notifyResync(event: SyncingTimeProviderResyncEvent): void {
    try {
      this.options.onResync?.(event);
    } catch {
      // Observability callbacks must not break clock updates.
    }
  }

  private notifySampleFailed(
    event: SyncingTimeProviderSampleFailedEvent,
  ): void {
    try {
      this.options.onSampleFailed?.(event);
    } catch {
      // Observability callbacks must not break clock updates.
    }
  }

  private notifyDriftWarning(
    event: SyncingTimeProviderDriftWarningEvent,
  ): void {
    try {
      this.options.onDriftWarning?.(event);
    } catch {
      // Observability callbacks must not break clock updates.
    }
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[midpoint] ?? 0;
  }

  return ((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2;
}

function positiveFiniteOr(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return value;
}
