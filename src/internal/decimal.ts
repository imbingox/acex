import BigNumber from "bignumber.js";
import type { DecimalInput } from "../types/index.ts";

export function toCanonical(value: DecimalInput): string {
  const bn = new BigNumber(value);
  return bn.isFinite() ? bn.toFixed() : bn.toString();
}
