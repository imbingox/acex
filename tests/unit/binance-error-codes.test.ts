import { expect, test } from "bun:test";
import { normalizeBinanceErrorCode } from "../../src/adapters/binance/error-codes.ts";

test("normalizeBinanceErrorCode maps PAPI UM codes to stable reasons", () => {
  expect(normalizeBinanceErrorCode("-1003")).toBe("rate_limited");
  expect(normalizeBinanceErrorCode("-1008")).toBe("rate_limited");
  expect(normalizeBinanceErrorCode("-1015")).toBe("rate_limited");
  expect(normalizeBinanceErrorCode("-5041")).toBe("rate_limited");

  expect(normalizeBinanceErrorCode("-1021")).toBe("timestamp_out_of_sync");
  expect(normalizeBinanceErrorCode("-5028")).toBe("timestamp_out_of_sync");

  expect(normalizeBinanceErrorCode("-2011")).toBe("order_not_found");
  expect(normalizeBinanceErrorCode("-2013")).toBe("order_not_found");

  expect(normalizeBinanceErrorCode("-2018")).toBe("insufficient_balance");
  expect(normalizeBinanceErrorCode("-2019")).toBe("insufficient_balance");

  expect(normalizeBinanceErrorCode("-5022")).toBe("would_take");

  expect(normalizeBinanceErrorCode("-4131")).toBe("filter_violation");
  expect(normalizeBinanceErrorCode("-2025")).toBe("filter_violation");
  expect(normalizeBinanceErrorCode("-1111")).toBe("filter_violation");
  expect(normalizeBinanceErrorCode("-4002")).toBe("filter_violation");
  expect(normalizeBinanceErrorCode("-4004")).toBe("filter_violation");
  expect(normalizeBinanceErrorCode("-4005")).toBe("filter_violation");
  expect(normalizeBinanceErrorCode("-4013")).toBe("filter_violation");
  expect(normalizeBinanceErrorCode("-4014")).toBe("filter_violation");
  expect(normalizeBinanceErrorCode("-4016")).toBe("filter_violation");
  expect(normalizeBinanceErrorCode("-4023")).toBe("filter_violation");
  expect(normalizeBinanceErrorCode("-4024")).toBe("filter_violation");
  expect(normalizeBinanceErrorCode("-4029")).toBe("filter_violation");
  expect(normalizeBinanceErrorCode("-4030")).toBe("filter_violation");
  expect(normalizeBinanceErrorCode("-4164")).toBe("filter_violation");
  expect(normalizeBinanceErrorCode("-4183")).toBe("filter_violation");
  expect(normalizeBinanceErrorCode("-4184")).toBe("filter_violation");
});

test("normalizeBinanceErrorCode leaves ambiguous or unknown codes as unknown", () => {
  expect(normalizeBinanceErrorCode("-2010")).toBe("unknown");
  expect(normalizeBinanceErrorCode("-2020")).toBe("unknown");
  expect(normalizeBinanceErrorCode("-2021")).toBe("unknown");
  expect(normalizeBinanceErrorCode("-5021")).toBe("unknown");
  expect(normalizeBinanceErrorCode("-4118")).toBe("unknown");
  expect(normalizeBinanceErrorCode("-51113")).toBe("unknown");
  expect(normalizeBinanceErrorCode("-999999")).toBe("unknown");
});
