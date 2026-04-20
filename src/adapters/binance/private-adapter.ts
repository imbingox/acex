import { createHmac } from "node:crypto";
import { createManagedWebSocket } from "../../internal/managed-websocket.ts";
import type { AccountCredentials, PositionSide } from "../../types/index.ts";
import type {
  PrivateAccountAdapter,
  PrivateAccountStreamCallbacks,
  PrivateAccountStreamOptions,
  RawAccountBootstrap,
  RawAccountUpdate,
  RawBalanceUpdate,
  RawPositionUpdate,
  RawRiskUpdate,
  StreamHandle,
} from "../types.ts";

type TimerHandle = ReturnType<typeof setInterval>;

interface BinancePapiBalance {
  asset?: string;
  totalWalletBalance?: string;
  crossMarginFree?: string;
  crossMarginLocked?: string;
  availableBalance?: string;
  maxWithdrawAmount?: string;
  balance?: string;
}

interface BinancePapiAccount {
  accountEquity?: string;
  totalEquity?: string;
  accountInitialMargin?: string;
  totalInitialMargin?: string;
  accountMaintMargin?: string;
  totalMaintMargin?: string;
  uniMMR?: string;
  updateTime?: number;
}

interface BinancePapiUmPosition {
  symbol?: string;
  positionAmt?: string;
  entryPrice?: string;
  markPrice?: string;
  unRealizedProfit?: string;
  unrealizedProfit?: string;
  liquidationPrice?: string;
  leverage?: string;
  positionSide?: string;
  updateTime?: number;
}

interface BinanceListenKeyResponse {
  listenKey?: string;
}

interface BinanceAccountUpdateBalance {
  a?: string;
  wb?: string;
  cw?: string;
  bc?: string;
}

interface BinanceAccountUpdatePosition {
  s?: string;
  pa?: string;
  ep?: string;
  cr?: string;
  up?: string;
  mt?: string;
  iw?: string;
  ps?: string;
  ma?: string;
}

interface BinanceAccountUpdateMessage {
  e?: string;
  E?: number;
  T?: number;
  a?: {
    B?: BinanceAccountUpdateBalance[];
    P?: BinanceAccountUpdatePosition[];
  };
}

const BINANCE_PAPI_REST_BASE_URL = "https://papi.binance.com";
const BINANCE_PAPI_WS_BASE_URL = "wss://fstream.binance.com/pm/ws";
const DEFAULT_RECV_WINDOW = 5_000;
const USDM_QUOTE_ASSETS = ["FDUSD", "USDC", "BUSD", "USDT"];

function requirePrivateCredentials(credentials: AccountCredentials): {
  apiKey: string;
  secret: string;
} {
  if (!credentials.apiKey || !credentials.secret) {
    throw new Error("Binance PAPI credentials require apiKey and secret");
  }

  return {
    apiKey: credentials.apiKey,
    secret: credentials.secret,
  };
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value !== "");
}

function getNumberOption(
  options: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = options?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function signQuery(query: string, secret: string): string {
  return createHmac("sha256", secret).update(query).digest("hex");
}

function normalizeUmSymbol(symbol: string): string {
  for (const quote of USDM_QUOTE_ASSETS) {
    if (symbol.endsWith(quote) && symbol.length > quote.length) {
      return `${symbol.slice(0, -quote.length)}/${quote}:${quote}`;
    }
  }

  return symbol;
}

function normalizePositionSide(value?: string): PositionSide {
  switch (value) {
    case "LONG":
      return "long";
    case "SHORT":
      return "short";
    default:
      return "net";
  }
}

function mapBalance(
  input: BinancePapiBalance,
  receivedAt: number,
): RawBalanceUpdate | undefined {
  if (!input.asset) {
    return undefined;
  }

  const total = firstString(input.totalWalletBalance, input.balance) ?? "0";
  const free =
    firstString(
      input.crossMarginFree,
      input.availableBalance,
      input.maxWithdrawAmount,
      total,
    ) ?? "0";

  return {
    asset: input.asset,
    free,
    used: input.crossMarginLocked,
    total,
    receivedAt,
  };
}

function mapAccountRisk(
  input: BinancePapiAccount,
  receivedAt: number,
): RawRiskUpdate | undefined {
  const risk: RawRiskUpdate = {
    equity: firstString(input.accountEquity, input.totalEquity),
    marginRatio: input.uniMMR,
    initialMargin: firstString(
      input.accountInitialMargin,
      input.totalInitialMargin,
    ),
    maintenanceMargin: firstString(
      input.accountMaintMargin,
      input.totalMaintMargin,
    ),
    exchangeTs: input.updateTime,
    receivedAt,
  };

  if (
    !risk.equity &&
    !risk.marginRatio &&
    !risk.initialMargin &&
    !risk.maintenanceMargin
  ) {
    return undefined;
  }

  return risk;
}

function mapUmPosition(
  input: BinancePapiUmPosition,
  receivedAt: number,
): RawPositionUpdate | undefined {
  if (!input.symbol) {
    return undefined;
  }

  return {
    symbol: normalizeUmSymbol(input.symbol),
    side: normalizePositionSide(input.positionSide),
    size: input.positionAmt ?? "0",
    entryPrice: input.entryPrice,
    markPrice: input.markPrice,
    unrealizedPnl: firstString(input.unRealizedProfit, input.unrealizedProfit),
    leverage: input.leverage,
    liquidationPrice: input.liquidationPrice,
    exchangeTs: input.updateTime,
    receivedAt,
  };
}

function mapAccountUpdateBalance(
  input: BinanceAccountUpdateBalance,
  exchangeTs: number | undefined,
  receivedAt: number,
): RawBalanceUpdate | undefined {
  if (!input.a) {
    return undefined;
  }

  const total = input.wb ?? "0";
  return {
    asset: input.a,
    free: input.cw ?? total,
    total,
    exchangeTs,
    receivedAt,
  };
}

function mapAccountUpdatePosition(
  input: BinanceAccountUpdatePosition,
  exchangeTs: number | undefined,
  receivedAt: number,
): RawPositionUpdate | undefined {
  if (!input.s) {
    return undefined;
  }

  return {
    symbol: normalizeUmSymbol(input.s),
    side: normalizePositionSide(input.ps),
    size: input.pa ?? "0",
    entryPrice: input.ep,
    unrealizedPnl: input.up,
    exchangeTs,
    receivedAt,
  };
}

function parseAccountUpdateMessage(
  data: string,
): BinanceAccountUpdateMessage | undefined {
  const parsed = JSON.parse(data) as BinanceAccountUpdateMessage;
  return parsed.e === "ACCOUNT_UPDATE" ? parsed : undefined;
}

function mapAccountUpdate(
  message: BinanceAccountUpdateMessage,
  receivedAt: number,
): RawAccountUpdate {
  const exchangeTs = message.T ?? message.E;
  return {
    balances: message.a?.B?.flatMap((balance) => {
      const mapped = mapAccountUpdateBalance(balance, exchangeTs, receivedAt);
      return mapped ? [mapped] : [];
    }),
    positions: message.a?.P?.flatMap((position) => {
      const mapped = mapAccountUpdatePosition(position, exchangeTs, receivedAt);
      return mapped ? [mapped] : [];
    }),
    exchangeTs,
    receivedAt,
  };
}

async function readJson<T>(response: Response, url: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Binance PAPI request failed: ${response.status} ${response.statusText} ${url} ${text}`,
    );
  }

  if (!text) {
    return {} as T;
  }

  return JSON.parse(text) as T;
}

export class BinancePrivateAdapter implements PrivateAccountAdapter {
  readonly exchange = "binance" as const;

  async bootstrapAccount(
    credentials: AccountCredentials,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawAccountBootstrap> {
    const receivedAt = Date.now();
    const [balances, account, positions] = await Promise.all([
      this.signedRequest<BinancePapiBalance[]>(
        "GET",
        "/papi/v1/balance",
        credentials,
        accountOptions,
      ),
      this.signedRequest<BinancePapiAccount>(
        "GET",
        "/papi/v1/account",
        credentials,
        accountOptions,
      ),
      this.signedRequest<BinancePapiUmPosition[]>(
        "GET",
        "/papi/v1/um/positionRisk",
        credentials,
        accountOptions,
      ),
    ]);

    return {
      balances: balances.flatMap((balance) => {
        const mapped = mapBalance(balance, receivedAt);
        return mapped ? [mapped] : [];
      }),
      positions: positions.flatMap((position) => {
        const mapped = mapUmPosition(position, receivedAt);
        return mapped ? [mapped] : [];
      }),
      risk: mapAccountRisk(account, receivedAt),
      exchangeTs: account.updateTime,
      receivedAt,
    };
  }

  createAccountStream(
    credentials: AccountCredentials,
    callbacks: PrivateAccountStreamCallbacks,
    options: PrivateAccountStreamOptions,
    _accountOptions?: Record<string, unknown>,
  ): StreamHandle {
    let closed = false;
    let listenKey: string | undefined;
    let keepAliveTimer: TimerHandle | undefined;
    let websocket: StreamHandle | undefined;
    let openedOnce = false;

    const clearKeepAlive = () => {
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = undefined;
      }
    };

    const closeListenKey = () => {
      if (!listenKey) {
        return;
      }

      const key = listenKey;
      listenKey = undefined;
      void this.closeUserDataStream(credentials, key).catch((error) => {
        callbacks.onError(
          error instanceof Error
            ? error
            : new Error("Failed to close Binance PAPI listenKey"),
        );
      });
    };

    const ready = (async () => {
      listenKey = await this.startUserDataStream(credentials);
      if (closed) {
        closeListenKey();
        return;
      }

      keepAliveTimer = setInterval(() => {
        if (!listenKey) {
          return;
        }

        void this.keepAliveUserDataStream(credentials, listenKey).catch(
          (error) => {
            callbacks.onError(
              error instanceof Error
                ? error
                : new Error("Failed to keep Binance PAPI listenKey alive"),
            );
          },
        );
      }, options.listenKeyKeepAliveMs);

      websocket = createManagedWebSocket<BinanceAccountUpdateMessage>({
        url: `${BINANCE_PAPI_WS_BASE_URL}/${listenKey}`,
        initialMessageTimeoutMs: options.openTimeoutMs,
        readyWhen: "open",
        now: options.now,
        parseMessage: parseAccountUpdateMessage,
        onOpen() {
          if (openedOnce) {
            callbacks.onReconnected();
          }
          openedOnce = true;
        },
        onMessage(message, receivedAt) {
          callbacks.onUpdate(mapAccountUpdate(message, receivedAt));
        },
        onUnexpectedClose() {
          callbacks.onDisconnected();
        },
        onError() {
          callbacks.onError(
            new Error("WebSocket error for Binance PAPI account stream"),
          );
        },
        reconnect: {
          initialDelayMs: options.reconnectDelayMs,
          maxDelayMs: options.reconnectMaxDelayMs,
          reconnectWithoutMessages: true,
        },
      });

      await websocket.ready;
    })();

    return {
      ready,
      close() {
        if (closed) {
          return;
        }

        closed = true;
        clearKeepAlive();
        websocket?.close();
        closeListenKey();
      },
    };
  }

  private async signedRequest<T>(
    method: "GET",
    path: string,
    credentials: AccountCredentials,
    accountOptions?: Record<string, unknown>,
  ): Promise<T> {
    const { apiKey, secret } = requirePrivateCredentials(credentials);
    const params = new URLSearchParams();
    params.set(
      "timestamp",
      `${getNumberOption(accountOptions, "timestamp") ?? Date.now()}`,
    );
    params.set(
      "recvWindow",
      `${getNumberOption(accountOptions, "recvWindow") ?? DEFAULT_RECV_WINDOW}`,
    );
    params.set("signature", signQuery(params.toString(), secret));

    const url = `${BINANCE_PAPI_REST_BASE_URL}${path}?${params.toString()}`;
    const response = await fetch(url, {
      method,
      headers: {
        "X-MBX-APIKEY": apiKey,
      },
    });

    return readJson<T>(response, url);
  }

  private async startUserDataStream(
    credentials: AccountCredentials,
  ): Promise<string> {
    const response = await this.userStreamRequest<BinanceListenKeyResponse>(
      "POST",
      credentials,
    );
    if (!response.listenKey) {
      throw new Error("Binance PAPI did not return a listenKey");
    }

    return response.listenKey;
  }

  private async keepAliveUserDataStream(
    credentials: AccountCredentials,
    listenKey: string,
  ): Promise<void> {
    await this.userStreamRequest<Record<string, never>>(
      "PUT",
      credentials,
      listenKey,
    );
  }

  private async closeUserDataStream(
    credentials: AccountCredentials,
    listenKey: string,
  ): Promise<void> {
    await this.userStreamRequest<Record<string, never>>(
      "DELETE",
      credentials,
      listenKey,
    );
  }

  private async userStreamRequest<T>(
    method: "POST" | "PUT" | "DELETE",
    credentials: AccountCredentials,
    listenKey?: string,
  ): Promise<T> {
    const { apiKey } = requirePrivateCredentials(credentials);
    const params = new URLSearchParams();
    if (listenKey) {
      params.set("listenKey", listenKey);
    }

    const query = params.toString();
    const url = `${BINANCE_PAPI_REST_BASE_URL}/papi/v1/listenKey${
      query ? `?${query}` : ""
    }`;
    const response = await fetch(url, {
      method,
      headers: {
        "X-MBX-APIKEY": apiKey,
      },
    });

    return readJson<T>(response, url);
  }
}
