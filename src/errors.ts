import { isTransportError } from "./internal/http-client.ts";
import type { Venue } from "./types/shared.ts";

export type AcexErrorCode =
  | "ACCOUNT_ALREADY_EXISTS"
  | "ACCOUNT_BOOTSTRAP_FAILED"
  | "ACCOUNT_NOT_FOUND"
  | "CLIENT_NOT_STARTED"
  | "CREDENTIALS_MISSING"
  | "EVENT_BUFFER_OVERFLOW"
  | "VENUE_NOT_SUPPORTED"
  | "MARKET_CATALOG_LOAD_FAILED"
  | "MARKET_SERVER_TIME_FETCH_FAILED"
  | "MARKET_INACTIVE"
  | "MARKET_FUNDING_RATE_UNSUPPORTED"
  | "MARKET_NOT_FOUND"
  | "MARKET_STREAM_TIMEOUT"
  | "ORDER_BOOTSTRAP_FAILED"
  | "ORDER_CANCEL_ALL_FAILED"
  | "ORDER_CANCEL_FAILED"
  | "ORDER_CREATE_FAILED"
  | "ORDER_FEE_RATE_FETCH_FAILED"
  | "ORDER_INPUT_INVALID";

export type AcexErrorTransportKind =
  | "timeout"
  | "http"
  | "network"
  | "rate_limited"
  | "parse";

export type VenueErrorReason =
  | "insufficient_balance"
  | "would_take"
  | "order_not_found"
  | "filter_violation"
  | "rate_limited"
  | "timestamp_out_of_sync"
  | "unknown";

export interface AcexVenueErrorDetails {
  readonly code?: string;
  readonly message?: string;
  readonly reason?: VenueErrorReason;
}

export interface AcexErrorTransportDetails {
  readonly kind?: AcexErrorTransportKind;
  readonly status?: number;
  readonly statusText?: string;
  readonly retryAfterMs?: number;
  readonly retryable?: boolean;
  readonly attempts?: number;
  readonly rawBody?: string;
  readonly url?: string;
}

export interface AcexErrorDetails {
  readonly venue?: Venue;
  readonly accountId?: string;
  readonly symbol?: string;
  readonly venueError?: AcexVenueErrorDetails;
  readonly transport?: AcexErrorTransportDetails;
  readonly orderState?: "not_placed" | "unknown";
}

export interface AcexErrorOptions {
  readonly cause?: unknown;
  readonly details?: AcexErrorDetails;
}

export class AcexError extends Error {
  readonly code: AcexErrorCode;
  readonly details?: AcexErrorDetails;
  override readonly cause?: unknown;

  constructor(
    code: AcexErrorCode,
    message: string,
    options: AcexErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AcexError";
    this.code = code;
    this.details = options.details;
    this.cause = options.cause;
  }
}

export function buildAcexErrorDetails(
  context?: Pick<AcexErrorDetails, "venue" | "accountId" | "symbol">,
  cause?: unknown,
): AcexErrorDetails | undefined {
  const transport = buildTransportDetails(cause);
  const venueError = parseVenueErrorDetails(transport?.rawBody);
  const details: AcexErrorDetails = {
    venue: context?.venue,
    accountId: context?.accountId,
    symbol: context?.symbol,
    venueError,
    transport,
  };

  return hasDetails(details) ? details : undefined;
}

export function isOrderStateUnknown(error: unknown): boolean {
  return error instanceof AcexError && error.details?.orderState === "unknown";
}

export function formatAcexErrorMessage(
  message: string,
  details?: AcexErrorDetails,
): string {
  const venueErrorMessage = details?.venueError?.message?.trim();
  if (!venueErrorMessage) {
    return message;
  }

  const venue = details?.venue;
  const venueLabel = venue ? formatVenueLabel(venue) : "Exchange";
  return `${message} (${venueLabel} rejected: ${venueErrorMessage})`;
}

function buildTransportDetails(
  cause: unknown,
): AcexErrorTransportDetails | undefined {
  if (!isTransportError(cause)) {
    return undefined;
  }

  return pruneUndefined({
    kind: cause.kind,
    status: cause.status,
    statusText: cause.statusText,
    retryAfterMs: cause.retryAfterMs,
    retryable: cause.retryable,
    attempts: cause.attempts,
    rawBody: cause.rawBody,
    url: cause.url,
  });
}

function parseVenueErrorDetails(
  rawBody: string | undefined,
): AcexVenueErrorDetails | undefined {
  if (!rawBody) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const code = record.code;
  const message = record.msg ?? record.message;

  if (
    (typeof code !== "string" && typeof code !== "number") ||
    typeof message !== "string" ||
    message.trim() === ""
  ) {
    return undefined;
  }

  return {
    code: String(code),
    message,
  };
}

function hasDetails(details: AcexErrorDetails): boolean {
  return Boolean(
    details.venue ||
      details.accountId ||
      details.symbol ||
      details.venueError ||
      details.transport ||
      details.orderState,
  );
}

function formatVenueLabel(venue: Venue): string {
  return `${venue.charAt(0).toUpperCase()}${venue.slice(1)}`;
}

function pruneUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as T;
}
