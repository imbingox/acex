export type AcexErrorCode =
  | "ACCOUNT_ALREADY_EXISTS"
  | "ACCOUNT_BOOTSTRAP_FAILED"
  | "ACCOUNT_NOT_FOUND"
  | "CLIENT_NOT_STARTED"
  | "CREDENTIALS_MISSING"
  | "VENUE_NOT_SUPPORTED"
  | "MARKET_CATALOG_LOAD_FAILED"
  | "MARKET_SERVER_TIME_FETCH_FAILED"
  | "MARKET_INACTIVE"
  | "MARKET_FUNDING_RATE_UNSUPPORTED"
  | "MARKET_NOT_FOUND"
  | "MARKET_STREAM_TIMEOUT"
  | "ORDER_BOOTSTRAP_FAILED"
  | "ORDER_CANCEL_ALL_FAILED"
  | "ORDER_CANCEL_FAILED"
  | "ORDER_CREATE_FAILED"
  | "ORDER_INPUT_INVALID";

export class AcexError extends Error {
  readonly code: AcexErrorCode;

  constructor(code: AcexErrorCode, message: string) {
    super(message);
    this.name = "AcexError";
    this.code = code;
  }
}
