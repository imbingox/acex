import BigNumber from "bignumber.js";
import type { DecimalInput } from "../types/index.ts";

export const CANONICAL_DECIMAL_STRING_PATTERN =
  /^(?:0|-?[1-9]\d*|-?(?:0|[1-9]\d*)\.\d*[1-9])$/;

/**
 * Convert a decimal value to its canonical string form: full precision, no
 * scientific notation, no trailing zeros.
 *
 * Throws on non-finite input (NaN / Infinity) so producers can never leak
 * sentinel strings into public output fields. Call sites that legitimately
 * accept non-finite input (e.g. order-input validation) must guard before
 * calling this.
 */
export function toCanonical(value: DecimalInput): string {
  if (
    typeof value === "string" &&
    CANONICAL_DECIMAL_STRING_PATTERN.test(value)
  ) {
    return value;
  }

  const bn = new BigNumber(value);
  if (!bn.isFinite()) {
    throw new RangeError(`invalid non-finite DecimalInput: ${bn.toString()}`);
  }
  return bn.toFixed();
}
