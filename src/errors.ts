export type AcexErrorCode =
  | "ACCOUNT_ALREADY_EXISTS"
  | "ACCOUNT_NOT_FOUND"
  | "CLIENT_NOT_STARTED"
  | "CREDENTIALS_MISSING";

export class AcexError extends Error {
  readonly code: AcexErrorCode;

  constructor(code: AcexErrorCode, message: string) {
    super(message);
    this.name = "AcexError";
    this.code = code;
  }
}
