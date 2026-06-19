import type { VenueErrorReason } from "../../errors.ts";

const BINANCE_RATE_LIMITED_CODES = new Set([
  "-1003",
  "-1008",
  "-1015",
  "-5041",
]);
const BINANCE_TIMESTAMP_OUT_OF_SYNC_CODES = new Set(["-1021", "-5028"]);
const BINANCE_ORDER_NOT_FOUND_CODES = new Set(["-2011", "-2013"]);
const BINANCE_INSUFFICIENT_BALANCE_CODES = new Set(["-2018", "-2019"]);
const BINANCE_WOULD_TAKE_CODES = new Set(["-5022"]);
const BINANCE_FILTER_VIOLATION_CODES = new Set([
  "-4131",
  "-2025",
  "-2027",
  "-1111",
  "-4002",
  "-4004",
  "-4005",
  "-4013",
  "-4014",
  "-4016",
  "-4023",
  "-4024",
  "-4029",
  "-4030",
  "-4164",
  "-4183",
  "-4184",
]);

export function normalizeBinanceErrorCode(code: string): VenueErrorReason {
  if (BINANCE_RATE_LIMITED_CODES.has(code)) {
    return "rate_limited";
  }
  if (BINANCE_TIMESTAMP_OUT_OF_SYNC_CODES.has(code)) {
    return "timestamp_out_of_sync";
  }
  if (BINANCE_ORDER_NOT_FOUND_CODES.has(code)) {
    return "order_not_found";
  }
  if (BINANCE_INSUFFICIENT_BALANCE_CODES.has(code)) {
    return "insufficient_balance";
  }
  if (BINANCE_WOULD_TAKE_CODES.has(code)) {
    return "would_take";
  }
  if (BINANCE_FILTER_VIOLATION_CODES.has(code)) {
    return "filter_violation";
  }

  return "unknown";
}
