import { expect, test } from "bun:test";
import {
  AcexError,
  buildAcexErrorDetails,
  formatAcexErrorMessage,
} from "../../src/errors.ts";
import { TransportError } from "../../src/internal/http-client.ts";

test("AcexError preserves code, cause, and details", () => {
  const cause = new Error("root failure");
  const details = {
    venue: "binance" as const,
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
    exchange: {
      code: "-2010",
      message: "Order would immediately trigger.",
    },
  };

  const error = new AcexError("ORDER_CREATE_FAILED", "Failed", {
    cause,
    details,
  });

  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe("AcexError");
  expect(error.code).toBe("ORDER_CREATE_FAILED");
  expect(error.message).toBe("Failed");
  expect(error.cause).toBe(cause);
  expect(error.details).toBe(details);
});

test("buildAcexErrorDetails extracts Binance-style exchange errors", () => {
  const cause = new TransportError("Binance PAPI request failed", {
    kind: "http",
    status: 400,
    statusText: "Bad Request",
    retryable: false,
    attempts: 1,
    rawBody: '{"code":-2010,"msg":"Order would immediately trigger."}',
    url: "https://papi.binance.com/papi/v1/um/order?query=[REDACTED]",
  });

  const details = buildAcexErrorDetails(
    {
      venue: "binance",
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
    },
    cause,
  );

  expect(details).toMatchObject({
    venue: "binance",
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
    exchange: {
      code: "-2010",
      message: "Order would immediately trigger.",
    },
    transport: {
      kind: "http",
      status: 400,
      statusText: "Bad Request",
      retryable: false,
      attempts: 1,
      rawBody: '{"code":-2010,"msg":"Order would immediately trigger."}',
      url: "https://papi.binance.com/papi/v1/um/order?query=[REDACTED]",
    },
  });
  expect(formatAcexErrorMessage("Failed to create order", details)).toBe(
    "Failed to create order (Binance rejected: Order would immediately trigger.)",
  );
});

test("buildAcexErrorDetails does not infer exchange details from unknown bodies", () => {
  const cause = new TransportError("Binance request failed", {
    kind: "http",
    status: 503,
    statusText: "Service Unavailable",
    retryable: true,
    attempts: 3,
    rawBody: "binance down",
    url: "https://fapi.binance.com/fapi/v1/exchangeInfo",
  });

  const details = buildAcexErrorDetails({ venue: "binance" }, cause);

  expect(details?.exchange).toBeUndefined();
  expect(details?.transport).toMatchObject({
    kind: "http",
    status: 503,
    rawBody: "binance down",
    url: "https://fapi.binance.com/fapi/v1/exchangeInfo",
  });
  expect(formatAcexErrorMessage("Failed to load markets", details)).toBe(
    "Failed to load markets",
  );
});
