import { expect, test } from "bun:test";
import {
  httpRequest,
  isTransportError,
  parseRetryAfterMs,
  redactSecrets,
} from "../../src/internal/http-client.ts";

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
    ...init,
  });
}

function retryPolicy(input?: { idempotent?: boolean; maxAttempts?: number }) {
  return {
    idempotent: input?.idempotent ?? true,
    maxAttempts: input?.maxAttempts ?? 3,
    initialDelayMs: 0,
    jitterRatio: 0,
    sleep: () => Promise.resolve(),
  };
}

test("httpRequest parses json, text, and empty bodies and exposes headers", async () => {
  const json = await httpRequest<{ ok: boolean }>({
    fetchFn: async () =>
      jsonResponse(
        { ok: true },
        {
          headers: {
            "x-mbx-used-weight-1m": "12",
          },
        },
      ),
    url: "https://example.test/json",
    parseAs: "json",
    retryPolicy: retryPolicy(),
  });
  expect(json.body).toEqual({ ok: true });
  expect(json.headers.get("x-mbx-used-weight-1m")).toBe("12");

  const text = await httpRequest<string>({
    fetchFn: async () => new Response("plain"),
    url: "https://example.test/text",
    parseAs: "text",
    retryPolicy: retryPolicy(),
  });
  expect(text.body).toBe("plain");

  const empty = await httpRequest<Record<string, never>>({
    fetchFn: async () => new Response(""),
    url: "https://example.test/empty",
    parseAs: "json",
    emptyBody: "empty_object",
    retryPolicy: retryPolicy(),
  });
  expect(empty.body).toEqual({});
});

test("httpRequest keeps non-2xx raw body and classifies rate limits", async () => {
  const error = await httpRequest({
    fetchFn: async () =>
      new Response(
        '{"code":-1003,"msg":"Too many requests","signature":"LEAKED-VALUE-123"}',
        {
          status: 429,
          statusText: "Too Many Requests",
          headers: {
            "Retry-After": "2",
            "X-MBX-USED-WEIGHT-1m": "1200",
          },
        },
      ),
    url: "https://example.test/private?signature=abc&timestamp=1",
    parseAs: "json",
    retryPolicy: retryPolicy(),
  }).catch((caught) => caught);

  expect(isTransportError(error)).toBe(true);
  if (!isTransportError(error)) {
    throw new Error("expected transport error");
  }
  expect(error.kind).toBe("rate_limited");
  expect(error.status).toBe(429);
  expect(error.retryAfterMs).toBe(2_000);
  expect(error.retryable).toBe(false);
  expect(error.rawBody).toContain("Too many requests");
  expect(error.rawBody).not.toContain("LEAKED-VALUE-123");
  expect(error.rawBody).toContain("[REDACTED]");
  expect(error.headers.get("x-mbx-used-weight-1m")).toBe("1200");
  expect(error.message).not.toContain("timestamp=1");
  expect(error.message).not.toContain("signature");
  expect(error.url).toBe("https://example.test/private?query=[REDACTED]");
});

test("httpRequest reports json parse failures as transport parse errors", async () => {
  const error = await httpRequest({
    fetchFn: async () => new Response("{bad json"),
    url: "https://example.test/json",
    parseAs: "json",
    retryPolicy: retryPolicy(),
  }).catch((caught) => caught);

  expect(isTransportError(error)).toBe(true);
  if (!isTransportError(error)) {
    throw new Error("expected transport error");
  }
  expect(error.kind).toBe("parse");
  expect(error.retryable).toBe(false);
  expect(error.rawBody).toBe("{bad json");
});

test("httpRequest distinguishes timeout, upstream abort, and network errors", async () => {
  const timeoutError = await httpRequest({
    fetchFn: async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(abortError()));
      }),
    url: "https://example.test/slow",
    timeoutMs: 1,
    parseAs: "json",
    retryPolicy: retryPolicy({ maxAttempts: 1 }),
  }).catch((caught) => caught);
  expect(isTransportError(timeoutError)).toBe(true);
  if (!isTransportError(timeoutError)) {
    throw new Error("expected timeout transport error");
  }
  expect(timeoutError.kind).toBe("timeout");

  const controller = new AbortController();
  const abortingFetch = async (
    _url: string | URL | Request,
    init?: RequestInit,
  ) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(abortError()));
      controller.abort();
    });
  const abortErrorResult = await httpRequest({
    fetchFn: abortingFetch,
    url: "https://example.test/abort",
    signal: controller.signal,
    timeoutMs: 10,
    parseAs: "json",
    retryPolicy: retryPolicy(),
  }).catch((caught) => caught);
  expect(isTransportError(abortErrorResult)).toBe(true);
  if (!isTransportError(abortErrorResult)) {
    throw new Error("expected abort transport error");
  }
  expect(abortErrorResult.kind).toBe("network");
  expect(abortErrorResult.retryable).toBe(false);

  const networkError = await httpRequest({
    fetchFn: async () => {
      throw new Error("socket closed");
    },
    url: "https://example.test/network",
    parseAs: "json",
    retryPolicy: retryPolicy({ maxAttempts: 1 }),
  }).catch((caught) => caught);
  expect(isTransportError(networkError)).toBe(true);
  if (!isTransportError(networkError)) {
    throw new Error("expected network transport error");
  }
  expect(networkError.kind).toBe("network");
});

test("httpRequest retries only explicit idempotent network, timeout, and 5xx failures", async () => {
  let getAttempts = 0;
  const get = await httpRequest<{ ok: true }>({
    fetchFn: async () => {
      getAttempts += 1;
      return getAttempts === 1
        ? new Response("temporary", {
            status: 503,
            statusText: "Service Unavailable",
          })
        : jsonResponse({ ok: true });
    },
    url: "https://example.test/read",
    parseAs: "json",
    retryPolicy: retryPolicy({ idempotent: true, maxAttempts: 2 }),
  });
  expect(get.body).toEqual({ ok: true });
  expect(getAttempts).toBe(2);

  let orderAttempts = 0;
  const orderError = await httpRequest({
    fetchFn: async () => {
      orderAttempts += 1;
      return new Response("temporary", {
        status: 503,
        statusText: "Service Unavailable",
      });
    },
    url: "https://example.test/order",
    method: "POST",
    parseAs: "json",
    retryPolicy: retryPolicy({ idempotent: false, maxAttempts: 3 }),
  }).catch((caught) => caught);
  expect(isTransportError(orderError)).toBe(true);
  expect(orderAttempts).toBe(1);

  let listenKeyAttempts = 0;
  await httpRequest({
    fetchFn: async () => {
      listenKeyAttempts += 1;
      if (listenKeyAttempts < 3) {
        throw new Error("socket closed");
      }
      return jsonResponse({});
    },
    url: "https://example.test/listenKey",
    method: "PUT",
    parseAs: "json",
    retryPolicy: retryPolicy({ idempotent: true, maxAttempts: 3 }),
  });
  expect(listenKeyAttempts).toBe(3);

  let rateLimitedAttempts = 0;
  const rateLimitedError = await httpRequest({
    fetchFn: async () => {
      rateLimitedAttempts += 1;
      return new Response("limited", {
        status: 418,
        statusText: "I'm a teapot",
      });
    },
    url: "https://example.test/listenKey",
    method: "PUT",
    parseAs: "json",
    retryPolicy: retryPolicy({ idempotent: true, maxAttempts: 3 }),
  }).catch((caught) => caught);
  expect(isTransportError(rateLimitedError)).toBe(true);
  if (!isTransportError(rateLimitedError)) {
    throw new Error("expected rate limited transport error");
  }
  expect(rateLimitedError.kind).toBe("rate_limited");
  expect(rateLimitedError.retryable).toBe(false);
  expect(rateLimitedAttempts).toBe(1);
});

test("httpRequest does not retry when the upstream signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  let attempts = 0;

  const error = await httpRequest({
    fetchFn: async () => {
      attempts += 1;
      return jsonResponse({});
    },
    url: "https://example.test/aborted",
    signal: controller.signal,
    parseAs: "json",
    retryPolicy: retryPolicy({ maxAttempts: 3 }),
  }).catch((caught) => caught);

  expect(isTransportError(error)).toBe(true);
  expect(attempts).toBe(0);
});

test("httpRequest abandons retry backoff immediately when the signal aborts", async () => {
  const controller = new AbortController();
  let attempts = 0;

  const error = await httpRequest({
    fetchFn: async () => {
      attempts += 1;
      throw new Error("socket closed");
    },
    url: "https://example.test/read",
    signal: controller.signal,
    parseAs: "json",
    retryPolicy: {
      idempotent: true,
      maxAttempts: 5,
      initialDelayMs: 0,
      jitterRatio: 0,
      // Abort mid-backoff then never resolve: without abort-aware backoff the
      // request would hang here instead of returning promptly.
      sleep: () => {
        controller.abort();
        return new Promise<void>(() => {});
      },
    },
  }).catch((caught) => caught);

  expect(isTransportError(error)).toBe(true);
  if (!isTransportError(error)) {
    throw new Error("expected transport error");
  }
  expect(error.kind).toBe("network");
  expect(attempts).toBe(1);
});

test("redaction removes secrets and complete signed query strings", () => {
  const message =
    "failed https://example.test/path?symbol=BTCUSDT&timestamp=1&recvWindow=5000&signature=abc apiKey=key secret=secret";

  const redacted = redactSecrets(message);

  expect(redacted).toContain("https://example.test/path?query=[REDACTED]");
  expect(redacted).not.toContain("timestamp=1");
  expect(redacted).not.toContain("recvWindow=5000");
  expect(redacted).not.toContain("signature");
  expect(redacted).not.toContain("apiKey=key");
  expect(redacted).not.toContain("secret=secret");
});

test("redaction folds signed query fragments without a URL scheme", () => {
  const redacted = redactSecrets(
    "/papi/v1/order?symbol=BTCUSDT&side=BUY&timestamp=1&signature=deadbeef",
  );

  expect(redacted).toContain("/papi/v1/order?query=[REDACTED]");
  expect(redacted).not.toContain("symbol=BTCUSDT");
  expect(redacted).not.toContain("side=BUY");
  expect(redacted).not.toContain("signature");
  expect(redacted).not.toContain("deadbeef");
});

test("parseRetryAfterMs supports seconds and HTTP-date values", () => {
  expect(parseRetryAfterMs("3")).toBe(3_000);

  const future = new Date(Date.now() + 5_000).toUTCString();
  const parsed = parseRetryAfterMs(future);
  expect(parsed).toBeGreaterThanOrEqual(0);
  expect(parsed).toBeLessThanOrEqual(5_000);
});
