import { expect, test } from "bun:test";
import { BinancePrivateAdapter } from "../../src/adapters/binance/private-adapter.ts";
import { isTransportError } from "../../src/internal/http-client.ts";
import { jsonResponse, textResponse } from "../support/test-utils.ts";

test("BinancePrivateAdapter safe reads do not retry HTTP failures", async () => {
  const attemptsByPath = new Map<string, number>();
  const adapter = new BinancePrivateAdapter({
    fetchFn: async (input) => {
      const url = new URL(input.toString());
      attemptsByPath.set(
        url.pathname,
        (attemptsByPath.get(url.pathname) ?? 0) + 1,
      );

      if (url.pathname === "/papi/v1/account") {
        return textResponse("binance down", {
          status: 503,
          statusText: "Service Unavailable",
        });
      }

      return jsonResponse([]);
    },
  });

  const error = await adapter
    .bootstrapAccount({
      apiKey: "key",
      secret: "secret",
    })
    .catch((caught: unknown) => caught);

  expect(attemptsByPath.get("/papi/v1/account")).toBe(1);
  expect(isTransportError(error)).toBe(true);
  if (!isTransportError(error)) {
    throw new Error("Expected TransportError");
  }
  expect(error.attempts).toBe(1);
  expect(error.kind).toBe("http");
});
