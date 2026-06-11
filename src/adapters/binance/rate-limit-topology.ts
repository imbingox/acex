import type {
  RateLimiter,
  RateLimitPriority,
  RateLimitTopology,
  RateLimitTopologyRegistry,
} from "../../types/index.ts";

const ONE_MINUTE_MS = 60_000;

const SPOT_REQUEST_WEIGHT_LIMIT_1M = 6_000;
const FAPI_REQUEST_WEIGHT_LIMIT_1M = 2_400;
const DAPI_REQUEST_WEIGHT_LIMIT_1M = 6_000;
const PAPI_REQUEST_WEIGHT_LIMIT_1M = 6_000;
const PAPI_CANCEL_REQUEST_WEIGHT_RESERVE_1M = 300;
const PAPI_ORDERS_LIMIT_1M = 1_200;

export const BINANCE_RATE_LIMIT_BUCKETS = {
  spotRequestWeight1m: "binance:spot:request-weight:1m",
  fapiRequestWeight1m: "binance:fapi:request-weight:1m",
  dapiRequestWeight1m: "binance:dapi:request-weight:1m",
  papiRequestWeight1m: "binance:papi:request-weight:1m",
  papiOrders1m: "binance:papi:orders:1m",
} as const;

export const BINANCE_RATE_LIMIT_PLANS = {
  spotExchangeInfo: "binance:spot:exchange-info",
  fapiExchangeInfo: "binance:fapi:exchange-info",
  dapiExchangeInfo: "binance:dapi:exchange-info",
  fapiServerTime: "binance:fapi:server-time",
  papiBalance: "binance:papi:balance",
  papiAccount: "binance:papi:account",
  papiPositionRisk: "binance:papi:position-risk",
  papiQueryOrder: "binance:papi:query-order",
  papiOpenOrdersSymbol: "binance:papi:open-orders:symbol",
  papiOpenOrdersAll: "binance:papi:open-orders:all",
  papiNewOrder: "binance:papi:new-order",
  papiCancelOrder: "binance:papi:cancel-order",
  papiCancelAllOrders: "binance:papi:cancel-all-orders",
  papiListenKey: "binance:papi:listen-key",
} as const;

export const BINANCE_RATE_LIMIT_TOPOLOGY: RateLimitTopology = {
  id: "binance-rest-rate-limits:v1",
  buckets: [
    {
      id: BINANCE_RATE_LIMIT_BUCKETS.spotRequestWeight1m,
      kind: "request_weight",
      limit: SPOT_REQUEST_WEIGHT_LIMIT_1M,
      intervalMs: ONE_MINUTE_MS,
      scope: ["venue"],
    },
    {
      id: BINANCE_RATE_LIMIT_BUCKETS.fapiRequestWeight1m,
      kind: "request_weight",
      limit: FAPI_REQUEST_WEIGHT_LIMIT_1M,
      intervalMs: ONE_MINUTE_MS,
      scope: ["venue"],
    },
    {
      id: BINANCE_RATE_LIMIT_BUCKETS.dapiRequestWeight1m,
      kind: "request_weight",
      limit: DAPI_REQUEST_WEIGHT_LIMIT_1M,
      intervalMs: ONE_MINUTE_MS,
      scope: ["venue"],
    },
    {
      id: BINANCE_RATE_LIMIT_BUCKETS.papiRequestWeight1m,
      kind: "request_weight",
      limit: PAPI_REQUEST_WEIGHT_LIMIT_1M,
      intervalMs: ONE_MINUTE_MS,
      scope: ["venue"],
      reserve: {
        priority: "cancel",
        units: PAPI_CANCEL_REQUEST_WEIGHT_RESERVE_1M,
      },
    },
    {
      id: BINANCE_RATE_LIMIT_BUCKETS.papiOrders1m,
      kind: "orders",
      limit: PAPI_ORDERS_LIMIT_1M,
      intervalMs: ONE_MINUTE_MS,
      scope: ["venue", "account"],
    },
  ],
  plans: [
    requestWeightPlan(
      BINANCE_RATE_LIMIT_PLANS.spotExchangeInfo,
      BINANCE_RATE_LIMIT_BUCKETS.spotRequestWeight1m,
      20,
    ),
    requestWeightPlan(
      BINANCE_RATE_LIMIT_PLANS.fapiExchangeInfo,
      BINANCE_RATE_LIMIT_BUCKETS.fapiRequestWeight1m,
      1,
    ),
    requestWeightPlan(
      BINANCE_RATE_LIMIT_PLANS.dapiExchangeInfo,
      BINANCE_RATE_LIMIT_BUCKETS.dapiRequestWeight1m,
      1,
    ),
    requestWeightPlan(
      BINANCE_RATE_LIMIT_PLANS.fapiServerTime,
      BINANCE_RATE_LIMIT_BUCKETS.fapiRequestWeight1m,
      1,
    ),
    requestWeightPlan(
      BINANCE_RATE_LIMIT_PLANS.papiBalance,
      BINANCE_RATE_LIMIT_BUCKETS.papiRequestWeight1m,
      20,
    ),
    requestWeightPlan(
      BINANCE_RATE_LIMIT_PLANS.papiAccount,
      BINANCE_RATE_LIMIT_BUCKETS.papiRequestWeight1m,
      20,
    ),
    requestWeightPlan(
      BINANCE_RATE_LIMIT_PLANS.papiPositionRisk,
      BINANCE_RATE_LIMIT_BUCKETS.papiRequestWeight1m,
      5,
    ),
    requestWeightPlan(
      BINANCE_RATE_LIMIT_PLANS.papiQueryOrder,
      BINANCE_RATE_LIMIT_BUCKETS.papiRequestWeight1m,
      1,
    ),
    requestWeightPlan(
      BINANCE_RATE_LIMIT_PLANS.papiOpenOrdersSymbol,
      BINANCE_RATE_LIMIT_BUCKETS.papiRequestWeight1m,
      1,
    ),
    requestWeightPlan(
      BINANCE_RATE_LIMIT_PLANS.papiOpenOrdersAll,
      BINANCE_RATE_LIMIT_BUCKETS.papiRequestWeight1m,
      40,
    ),
    {
      id: BINANCE_RATE_LIMIT_PLANS.papiNewOrder,
      costs: [
        {
          bucketId: BINANCE_RATE_LIMIT_BUCKETS.papiRequestWeight1m,
          cost: 0,
        },
        {
          bucketId: BINANCE_RATE_LIMIT_BUCKETS.papiOrders1m,
          cost: 1,
        },
      ],
    },
    requestWeightPlan(
      BINANCE_RATE_LIMIT_PLANS.papiCancelOrder,
      BINANCE_RATE_LIMIT_BUCKETS.papiRequestWeight1m,
      1,
      "cancel",
    ),
    requestWeightPlan(
      BINANCE_RATE_LIMIT_PLANS.papiCancelAllOrders,
      BINANCE_RATE_LIMIT_BUCKETS.papiRequestWeight1m,
      1,
      "cancel",
    ),
    requestWeightPlan(
      BINANCE_RATE_LIMIT_PLANS.papiListenKey,
      BINANCE_RATE_LIMIT_BUCKETS.papiRequestWeight1m,
      1,
    ),
  ],
};

export function registerBinanceRateLimitTopology(
  rateLimiter: RateLimiter | undefined,
): void {
  const registry = getRateLimitTopologyRegistry(rateLimiter);
  registry?.registerRateLimitTopology(BINANCE_RATE_LIMIT_TOPOLOGY);
}

export function getBinanceCatalogRateLimitPlanId(
  endpointKey: string,
): string | undefined {
  switch (endpointKey) {
    case "GET /api/v3/exchangeInfo":
      return BINANCE_RATE_LIMIT_PLANS.spotExchangeInfo;
    case "GET /fapi/v1/exchangeInfo":
      return BINANCE_RATE_LIMIT_PLANS.fapiExchangeInfo;
    case "GET /dapi/v1/exchangeInfo":
      return BINANCE_RATE_LIMIT_PLANS.dapiExchangeInfo;
    default:
      return undefined;
  }
}

export function getBinanceServerTimeRateLimitPlanId(): string {
  return BINANCE_RATE_LIMIT_PLANS.fapiServerTime;
}

export function getBinancePapiRateLimitPlanId(
  method: string,
  path: string,
  queryParams?: Record<string, string | undefined>,
): string | undefined {
  switch (`${method} ${path}`) {
    case "GET /papi/v1/balance":
      return BINANCE_RATE_LIMIT_PLANS.papiBalance;
    case "GET /papi/v1/account":
      return BINANCE_RATE_LIMIT_PLANS.papiAccount;
    case "GET /papi/v1/um/positionRisk":
      return BINANCE_RATE_LIMIT_PLANS.papiPositionRisk;
    case "GET /papi/v1/um/order":
      return BINANCE_RATE_LIMIT_PLANS.papiQueryOrder;
    case "GET /papi/v1/um/openOrders":
      return queryParams?.symbol
        ? BINANCE_RATE_LIMIT_PLANS.papiOpenOrdersSymbol
        : BINANCE_RATE_LIMIT_PLANS.papiOpenOrdersAll;
    case "POST /papi/v1/um/order":
      return BINANCE_RATE_LIMIT_PLANS.papiNewOrder;
    case "DELETE /papi/v1/um/order":
      return BINANCE_RATE_LIMIT_PLANS.papiCancelOrder;
    case "DELETE /papi/v1/um/allOpenOrders":
      return BINANCE_RATE_LIMIT_PLANS.papiCancelAllOrders;
    case "POST /papi/v1/listenKey":
    case "PUT /papi/v1/listenKey":
    case "DELETE /papi/v1/listenKey":
      return BINANCE_RATE_LIMIT_PLANS.papiListenKey;
    default:
      return undefined;
  }
}

function requestWeightPlan(
  id: string,
  bucketId: string,
  cost: number,
  priority?: RateLimitPriority,
): RateLimitTopology["plans"][number] {
  return {
    id,
    costs: [{ bucketId, cost }],
    priority,
  };
}

function getRateLimitTopologyRegistry(
  rateLimiter: RateLimiter | undefined,
): RateLimitTopologyRegistry | undefined {
  if (!rateLimiter) {
    return undefined;
  }

  const candidate = rateLimiter as RateLimiter &
    Partial<RateLimitTopologyRegistry>;
  return isRateLimitTopologyRegistry(candidate) ? candidate : undefined;
}

function isRateLimitTopologyRegistry(
  value: RateLimiter & Partial<RateLimitTopologyRegistry>,
): value is RateLimiter & RateLimitTopologyRegistry {
  return typeof value.registerRateLimitTopology === "function";
}
