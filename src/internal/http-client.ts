export type TransportErrorKind =
  | "timeout"
  | "http"
  | "network"
  | "rate_limited"
  | "parse";

export type HttpParseAs = "json" | "text" | "none";
export type JsonParseMode = "text" | "response";
export type EmptyBodyStrategy = "empty_object" | "empty_string" | "undefined";

export interface HttpRetryPolicy {
  readonly idempotent: boolean;
  readonly maxAttempts: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitterRatio?: number;
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface HttpClientMessages {
  http?(input: HttpErrorMessageInput): string;
  timeout?(input: HttpErrorMessageInput): string;
  aborted?(input: HttpErrorMessageInput): string;
  network?(input: HttpErrorMessageInput): string;
  parse?(input: HttpErrorMessageInput): string;
}

export interface HttpRequestOptions {
  readonly fetchFn?: FetchLike;
  readonly url: string | URL;
  readonly method?: string;
  readonly headers?: RequestInit["headers"];
  readonly body?: RequestInit["body"];
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly parseAs: HttpParseAs;
  readonly jsonParseMode?: JsonParseMode;
  readonly emptyBody?: EmptyBodyStrategy;
  readonly retryPolicy: HttpRetryPolicy;
  readonly messages?: HttpClientMessages;
}

export interface HttpClientResponse<T> {
  readonly body: T;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly rawBody?: string;
  readonly url: string;
  readonly redactedUrl: string;
  readonly attempts: number;
}

export interface HttpErrorMessageInput {
  readonly kind: TransportErrorKind;
  readonly status?: number;
  readonly statusText?: string;
  readonly retryAfterMs?: number;
  readonly attempts: number;
  readonly rawBody?: string;
  readonly url: string;
}

export interface TransportErrorInit extends HttpErrorMessageInput {
  readonly headers?: Headers;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

export class TransportError extends Error {
  readonly isAcexTransportError = true;
  readonly kind: TransportErrorKind;
  readonly status?: number;
  readonly statusText?: string;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;
  readonly attempts: number;
  readonly headers: Headers;
  readonly rawBody?: string;
  readonly url: string;
  override readonly cause?: unknown;

  constructor(message: string, init: TransportErrorInit) {
    super(message, { cause: init.cause });
    this.name = "TransportError";
    this.kind = init.kind;
    this.status = init.status;
    this.statusText = init.statusText;
    this.retryAfterMs = init.retryAfterMs;
    this.retryable = init.retryable;
    this.attempts = init.attempts;
    this.headers = init.headers ?? new Headers();
    this.rawBody = init.rawBody;
    this.url = init.url;
    this.cause = init.cause;
  }
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface AttemptErrorInput {
  readonly kind: TransportErrorKind;
  readonly status?: number;
  readonly statusText?: string;
  readonly headers?: Headers;
  readonly rawBody?: string;
  readonly retryAfterMs?: number;
  readonly attempts: number;
  readonly redactedUrl: string;
  readonly retryable: boolean;
  readonly aborted?: boolean;
  readonly cause?: unknown;
  readonly messages?: HttpClientMessages;
}

const DEFAULT_INITIAL_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 1_000;
const DEFAULT_JITTER_RATIO = 0.2;
const SENSITIVE_QUERY_KEYS = new Set([
  "apikey",
  "api_key",
  "api-key",
  "key",
  "secret",
  "signature",
  "token",
  "access_token",
  "listenkey",
  "listen_key",
  "passphrase",
]);

export function isTransportError(error: unknown): error is TransportError {
  if (!error || typeof error !== "object") {
    return false;
  }

  const record = error as Record<string, unknown>;
  return (
    record.isAcexTransportError === true &&
    typeof record.kind === "string" &&
    typeof record.retryable === "boolean" &&
    typeof record.attempts === "number"
  );
}

export function redactSecrets(value: string): string {
  let redacted = value.replace(/https?:\/\/[^\s)]+/g, redactUrlMatch);
  redacted = redacted.replace(
    /([?&](?:api[_-]?key|key|secret|signature|token|access_token|listen[_-]?key|passphrase)=)[^&\s)]+/gi,
    "$1[REDACTED]",
  );
  redacted = redacted.replace(
    /("(?:api[_-]?key|key|secret|signature|token|access_token|listen[_-]?key|passphrase)"\s*:\s*")[^"]*(")/gi,
    "$1[REDACTED]$2",
  );
  redacted = redacted.replace(
    /((?:api[_-]?key|key|secret|signature|token|access_token|listen[_-]?key|passphrase)\s*[:=]\s*)[^\s,;)"']+/gi,
    "$1[REDACTED]",
  );
  redacted = redacted.replace(
    /([?&])signature=\[REDACTED\]/gi,
    "$1query=[REDACTED]",
  );
  redacted = redacted.replace(
    /"signature"\s*:\s*"\[REDACTED\]"/gi,
    '"redacted":"[REDACTED]"',
  );
  redacted = redacted.replace(
    /signature\s*[:=]\s*\[REDACTED\]/gi,
    "query=[REDACTED]",
  );
  return redacted;
}

function redactUrlMatch(match: string): string {
  try {
    const url = new URL(match);
    if (url.searchParams.has("signature")) {
      url.search = "?query=[REDACTED]";
      return url.toString();
    }

    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }

    return url.toString();
  } catch {
    return match;
  }
}

export function redactUrl(input: string | URL): string {
  const rawUrl = input.toString();
  try {
    const url = new URL(rawUrl);
    const hasSignature = url.searchParams.has("signature");
    if (hasSignature) {
      url.search = "?query=[REDACTED]";
      return url.toString();
    }

    let changed = false;
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        url.searchParams.set(key, "[REDACTED]");
        changed = true;
      }
    }

    return changed ? url.toString() : rawUrl;
  } catch {
    return redactSecrets(rawUrl);
  }
}

export function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }

  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) {
    return undefined;
  }

  const deltaMs = dateMs - Date.now();
  return deltaMs > 0 ? deltaMs : 0;
}

export async function httpRequest<T>(
  options: HttpRequestOptions,
): Promise<HttpClientResponse<T>> {
  const fetchFn = options.fetchFn ?? fetch;
  const url = options.url.toString();
  const redactedUrl = redactUrl(options.url);
  const maxAttempts = Math.max(1, Math.floor(options.retryPolicy.maxAttempts));
  let lastError: TransportError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw buildAttemptError({
        kind: "network",
        attempts: attempt,
        redactedUrl,
        retryable: false,
        aborted: true,
        messages: options.messages,
      });
    }

    try {
      return await executeAttempt<T>(
        options,
        fetchFn,
        url,
        redactedUrl,
        attempt,
      );
    } catch (error) {
      const transportError = isTransportError(error)
        ? error
        : buildAttemptError({
            kind: "network",
            attempts: attempt,
            redactedUrl,
            retryable: retryableForKind("network", undefined, options),
            cause: error,
            messages: options.messages,
          });
      lastError = transportError;
      if (!shouldRetry(transportError, attempt, maxAttempts, options)) {
        throw transportError;
      }

      await delayBeforeRetry(attempt, options.retryPolicy);
    }
  }

  throw lastError;
}

async function executeAttempt<T>(
  options: HttpRequestOptions,
  fetchFn: FetchLike,
  url: string,
  redactedUrl: string,
  attempts: number,
): Promise<HttpClientResponse<T>> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const onUpstreamAbort = (): void => {
    controller.abort();
  };

  if (options.signal?.aborted) {
    controller.abort();
  } else {
    options.signal?.addEventListener("abort", onUpstreamAbort, { once: true });
  }

  if (timeoutMs !== undefined) {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  try {
    const response = await fetchFn(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });
    const headers = new Headers(response.headers);

    if (!response.ok) {
      const rawBody = redactSecrets(await response.text());
      const kind: TransportErrorKind =
        response.status === 429 || response.status === 418
          ? "rate_limited"
          : "http";
      const retryAfterMs = parseRetryAfterMs(headers.get("Retry-After"));
      throw buildAttemptError({
        kind,
        status: response.status,
        statusText: response.statusText,
        headers,
        rawBody,
        retryAfterMs,
        attempts,
        redactedUrl,
        retryable: retryableForKind(kind, response.status, options),
        messages: options.messages,
      });
    }

    const parsed = await parseResponseBody<T>(
      response,
      options,
      attempts,
      redactedUrl,
    );
    return {
      body: parsed.body,
      status: response.status,
      statusText: response.statusText,
      headers,
      rawBody: parsed.rawBody,
      url,
      redactedUrl,
      attempts,
    };
  } catch (error) {
    if (isTransportError(error)) {
      throw error;
    }

    if (isAbortError(error)) {
      throw buildAttemptError({
        kind: timedOut ? "timeout" : "network",
        attempts,
        redactedUrl,
        retryable: timedOut
          ? retryableForKind("timeout", undefined, options)
          : false,
        aborted: !timedOut,
        cause: error,
        messages: options.messages,
      });
    }

    throw buildAttemptError({
      kind: "network",
      attempts,
      redactedUrl,
      retryable: retryableForKind("network", undefined, options),
      cause: error,
      messages: options.messages,
    });
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    options.signal?.removeEventListener("abort", onUpstreamAbort);
  }
}

async function parseResponseBody<T>(
  response: Response,
  options: HttpRequestOptions,
  attempts: number,
  redactedUrl: string,
): Promise<{ body: T; rawBody?: string }> {
  if (options.parseAs === "none") {
    return { body: undefined as T };
  }

  if (options.parseAs === "text") {
    const rawBody = await response.text();
    return { body: rawBody as T, rawBody };
  }

  if (options.jsonParseMode === "response") {
    try {
      return { body: (await response.json()) as T };
    } catch (error) {
      throw buildAttemptError({
        kind: "parse",
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
        attempts,
        redactedUrl,
        retryable: false,
        cause: error,
        messages: options.messages,
      });
    }
  }

  const rawBody = await response.text();
  if (!rawBody) {
    switch (options.emptyBody ?? "undefined") {
      case "empty_object":
        return { body: {} as T, rawBody };
      case "empty_string":
        return { body: "" as T, rawBody };
      case "undefined":
        return { body: undefined as T, rawBody };
    }
  }

  try {
    return { body: JSON.parse(rawBody) as T, rawBody };
  } catch (error) {
    throw buildAttemptError({
      kind: "parse",
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
      rawBody: redactSecrets(rawBody),
      attempts,
      redactedUrl,
      retryable: false,
      cause: error,
      messages: options.messages,
    });
  }
}

function buildAttemptError(input: AttemptErrorInput): TransportError {
  const messageInput: HttpErrorMessageInput = {
    kind: input.kind,
    status: input.status,
    statusText: input.statusText,
    retryAfterMs: input.retryAfterMs,
    attempts: input.attempts,
    rawBody: input.rawBody,
    url: input.redactedUrl,
  };
  const message =
    messageForKind(input.messages, input.kind, input.aborted)?.(messageInput) ??
    defaultMessage(messageInput);

  return new TransportError(message, {
    ...messageInput,
    headers: input.headers,
    retryable: input.retryable,
    cause: input.cause,
  });
}

function messageForKind(
  messages: HttpClientMessages | undefined,
  kind: TransportErrorKind,
  aborted: boolean | undefined,
): ((input: HttpErrorMessageInput) => string) | undefined {
  if (kind === "network" && aborted) {
    return messages?.aborted ?? messages?.network;
  }
  if (kind === "http" || kind === "rate_limited") {
    return messages?.http;
  }
  return messages?.[kind];
}

function defaultMessage(input: HttpErrorMessageInput): string {
  switch (input.kind) {
    case "timeout":
      return `HTTP request timeout after attempt ${input.attempts}: ${input.url}`;
    case "network":
      return `HTTP request failed: ${input.url}`;
    case "parse":
      return `HTTP response parse failed: ${input.url}`;
    case "rate_limited":
    case "http": {
      const status = [input.status, input.statusText].filter(Boolean).join(" ");
      const body = input.rawBody ? ` ${input.rawBody}` : "";
      return `HTTP request failed: ${status} ${input.url}${body}`;
    }
  }
}

function retryableForKind(
  kind: TransportErrorKind,
  status: number | undefined,
  options: HttpRequestOptions,
): boolean {
  if (!options.retryPolicy.idempotent || options.signal?.aborted) {
    return false;
  }

  if (kind === "network" || kind === "timeout") {
    return true;
  }

  if (kind === "http" && status !== undefined) {
    return status >= 500 && status <= 599;
  }

  return false;
}

function shouldRetry(
  error: TransportError,
  attempt: number,
  maxAttempts: number,
  options: HttpRequestOptions,
): boolean {
  return error.retryable && attempt < maxAttempts && !options.signal?.aborted;
}

async function delayBeforeRetry(
  attempt: number,
  retryPolicy: HttpRetryPolicy,
): Promise<void> {
  const sleep = retryPolicy.sleep ?? defaultSleep;
  const baseDelay = Math.min(
    retryPolicy.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    (retryPolicy.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS) *
      2 ** Math.max(0, attempt - 1),
  );
  const jitterRatio = retryPolicy.jitterRatio ?? DEFAULT_JITTER_RATIO;
  const random = retryPolicy.random ?? Math.random;
  const jitter = baseDelay * jitterRatio * (random() * 2 - 1);
  await sleep(Math.max(0, Math.round(baseDelay + jitter)));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
