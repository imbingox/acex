import { expect, test } from "bun:test";
import { shouldApplyWatermarkedUpdate } from "../../src/internal/watermark.ts";

test("stream updates with stale exchange timestamps fail cross-clock watermark guard", () => {
  expect(
    shouldApplyWatermarkedUpdate(
      {
        receivedAt: 1_000_000,
      },
      {
        exchangeTs: 980_000,
        receivedAt: 1_000_100,
      },
      {
        source: "stream",
        graceMs: 10_000,
      },
    ),
  ).toBe(false);
});

test("stream updates within cross-clock grace can apply when locally newer", () => {
  expect(
    shouldApplyWatermarkedUpdate(
      {
        receivedAt: 1_000_000,
      },
      {
        exchangeTs: 995_000,
        receivedAt: 1_000_100,
      },
      {
        source: "stream",
        graceMs: 10_000,
      },
    ),
  ).toBe(true);
});
