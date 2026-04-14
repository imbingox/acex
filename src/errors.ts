export type AcexErrorCode =
  | "ACCOUNT_ALREADY_EXISTS"
  | "ACCOUNT_NOT_FOUND"
  | "CLIENT_NOT_STARTED"
  | "CREDENTIALS_MISSING"
  | "EXCHANGE_NOT_SUPPORTED"
  | "MARKET_CATALOG_LOAD_FAILED"
  | "MARKET_INACTIVE"
  | "MARKET_NOT_FOUND"
  | "MARKET_STREAM_TIMEOUT";

export class AcexError extends Error {
  readonly code: AcexErrorCode;

  constructor(code: AcexErrorCode, message: string) {
    super(message);
    this.name = "AcexError";
    this.code = code;
  }
}
