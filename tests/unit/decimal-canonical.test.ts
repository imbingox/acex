import { expect, test } from "bun:test";
import BigNumber from "bignumber.js";
import {
  CANONICAL_DECIMAL_STRING_PATTERN,
  toCanonical,
} from "../../src/internal/decimal.ts";

const MUST_REJECT = [
  "-0",
  "0.0",
  "-0.0",
  "1.50",
  "1.0",
  ".5",
  "01",
  "00",
  "1e5",
  "+1",
  " 1",
  "",
  "NaN",
  "Infinity",
];

const MUST_ACCEPT = [
  "0",
  "5",
  "-5",
  "10",
  "0.5",
  "-0.5",
  "1.5",
  "100",
  "123.456",
  "-0.001",
];

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function integer(random: () => number, min: number, max: number): number {
  return Math.floor(random() * (max - min + 1)) + min;
}

function digits(random: () => number, minLength: number, maxLength: number) {
  const length = integer(random, minLength, maxLength);
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String(integer(random, 0, 9));
  }
  return value;
}

function nonZeroDigits(
  random: () => number,
  minLength: number,
  maxLength: number,
): string {
  return `${integer(random, 1, 9)}${digits(random, minLength - 1, maxLength - 1)}`;
}

function randomString(random: () => number): string {
  const alphabet = "0123456789-+eE. NaIfity";
  const length = integer(random, 0, 40);
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += alphabet[integer(random, 0, alphabet.length - 1)] ?? "";
  }
  return value;
}

function randomDecimalish(random: () => number): string {
  const sign = random() < 0.25 ? "-" : random() < 0.1 ? "+" : "";
  const intPart =
    random() < 0.2
      ? ""
      : random() < 0.35
        ? "0"
        : random() < 0.5
          ? `0${digits(random, 1, 6)}`
          : nonZeroDigits(random, 1, 12);
  const fraction =
    random() < 0.45 ? "" : `.${random() < 0.2 ? "" : digits(random, 1, 12)}`;
  const exponent =
    random() < 0.15
      ? `${random() < 0.5 ? "e" : "E"}${random() < 0.5 ? "-" : ""}${digits(random, 1, 3)}`
      : "";
  const padding = random() < 0.1 ? (random() < 0.5 ? " " : "\t") : "";

  return `${padding}${sign}${intPart}${fraction}${exponent}${padding}`;
}

function randomBigNumber(random: () => number): BigNumber {
  if (random() < 0.05) {
    return new BigNumber(random() < 0.5 ? "0" : "-0");
  }

  const sign = random() < 0.5 ? "-" : "";
  const integerPart = nonZeroDigits(random, 1, 24);
  const fraction = random() < 0.6 ? `.${digits(random, 1, 24)}` : "";
  const exponent = integer(random, -30, 30);
  return new BigNumber(`${sign}${integerPart}${fraction}e${exponent}`);
}

test("canonical decimal string pattern accepts and rejects documented vectors", () => {
  for (const value of MUST_REJECT) {
    expect(CANONICAL_DECIMAL_STRING_PATTERN.test(value)).toBe(false);
  }

  for (const value of MUST_ACCEPT) {
    expect(CANONICAL_DECIMAL_STRING_PATTERN.test(value)).toBe(true);
    expect(toCanonical(value)).toBe(value);
  }
});

test("canonical decimal string pattern has no false positives for fuzzed strings", () => {
  const random = createRandom(0xdec1_a1);
  let matched = 0;

  for (let index = 0; index < 50_000; index += 1) {
    const value =
      index % 2 === 0 ? randomString(random) : randomDecimalish(random);
    if (!CANONICAL_DECIMAL_STRING_PATTERN.test(value)) {
      continue;
    }

    matched += 1;
    expect(new BigNumber(value).toFixed()).toBe(value);
  }

  expect(matched).toBeGreaterThan(1_000);
});

test("BigNumber toFixed output hits the canonical decimal fast-path pattern", () => {
  const random = createRandom(0xb16_2026);

  for (let index = 0; index < 20_000; index += 1) {
    const value = randomBigNumber(random).toFixed();
    expect(CANONICAL_DECIMAL_STRING_PATTERN.test(value)).toBe(true);
    expect(toCanonical(value)).toBe(value);
  }
});
