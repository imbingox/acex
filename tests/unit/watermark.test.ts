import { expect, test } from "bun:test";
import {
  canDeleteMissingFromSnapshot,
  shouldApplyWatermarkedUpdate,
} from "../../src/internal/watermark.ts";

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

test("REST updates with stale exchange timestamps fail cross-clock watermark guard", () => {
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
        source: "rest",
        requestStartedAt: 1_000_000,
        graceMs: 10_000,
      },
    ),
  ).toBe(false);
});

test("REST updates within cross-clock grace can apply when request predates current state", () => {
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
        source: "rest",
        requestStartedAt: 1_000_000,
        graceMs: 10_000,
      },
    ),
  ).toBe(true);
});

test("REST updates cannot overwrite newer local state when request started earlier", () => {
  expect(
    shouldApplyWatermarkedUpdate(
      {
        receivedAt: 1_000_100,
      },
      {
        receivedAt: 1_000_200,
      },
      {
        source: "rest",
        requestStartedAt: 1_000_000,
      },
    ),
  ).toBe(false);
});

test("command updates without exchange timestamps apply when local state predates the command", () => {
  expect(
    shouldApplyWatermarkedUpdate(
      {
        exchangeTs: 1_000_000,
        receivedAt: 1_000_050,
      },
      {
        receivedAt: 1_000_200,
      },
      {
        source: "command",
        requestStartedAt: 1_000_100,
        graceMs: 10_000,
      },
    ),
  ).toBe(true);
});

test("command updates without exchange timestamps cannot overwrite state newer than the command", () => {
  expect(
    shouldApplyWatermarkedUpdate(
      {
        exchangeTs: 1_000_000,
        receivedAt: 1_000_150,
      },
      {
        receivedAt: 1_000_200,
      },
      {
        source: "command",
        requestStartedAt: 1_000_100,
        graceMs: 10_000,
      },
    ),
  ).toBe(false);
});

test("snapshot deletion guard prevents deleting records newer than the REST request", () => {
  expect(
    canDeleteMissingFromSnapshot(
      {
        receivedAt: 1_000_100,
      },
      {
        requestStartedAt: 1_000_000,
      },
    ),
  ).toBe(false);
});

test("snapshot deletion guard prevents deleting records newer than the REST snapshot exchange timestamp", () => {
  expect(
    canDeleteMissingFromSnapshot(
      {
        exchangeTs: 1_000_100,
        receivedAt: 999_900,
      },
      {
        requestStartedAt: 1_000_000,
        snapshotExchangeTs: 1_000_000,
      },
    ),
  ).toBe(false);
});

test("snapshot deletion guard allows deleting stale records missing from the REST snapshot", () => {
  expect(
    canDeleteMissingFromSnapshot(
      {
        exchangeTs: 999_900,
        receivedAt: 999_900,
      },
      {
        requestStartedAt: 1_000_000,
        snapshotExchangeTs: 1_000_000,
      },
    ),
  ).toBe(true);
});
