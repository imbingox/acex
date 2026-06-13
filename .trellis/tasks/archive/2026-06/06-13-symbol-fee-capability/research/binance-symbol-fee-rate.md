# Binance symbol fee rate research

## Question

How should the SDK fetch symbol-level trading fee rates for Binance PAPI UM symbols?

## Findings

* Binance Portfolio Margin exposes `GET /papi/v1/um/commissionRate`.
* The endpoint is signed USER_DATA and therefore account-scoped.
* Request parameters include `symbol`, `timestamp`, and optional `recvWindow`.
* Response fields are `symbol`, `makerCommissionRate`, and `takerCommissionRate`.
* The endpoint request weight is 20, so it needs an explicit rate-limit plan instead of piggybacking on low-weight order queries.
* The SDK currently routes Binance order commands through PAPI UM only, and symbol mapping for commands already converts unified symbols such as `BTC/USDT:USDT` to venue ids such as `BTCUSDT`.

## Mapping to this repo

* This capability belongs in the private/order account path, not the public market catalog, because rates are account/VIP/discount dependent.
* Public API should accept unified `symbol` and `accountId`.
* Binance adapter should use the existing PAPI signed request helper and existing UM catalog mapping.
* Returned rates should stay as canonical decimal strings.
* Existing `order.trade` fee events remain the source for actual paid fee amounts; this new API returns rates only.

## Candidate public shape

```ts
interface GetSymbolFeeRateInput {
  accountId: string;
  symbol: string;
}

interface SymbolFeeRate {
  accountId: string;
  venue: Venue;
  symbol: string;
  maker: string;
  taker: string;
  receivedAt: number;
}
```

Method location:

```ts
client.order.getSymbolFeeRate({ accountId, symbol })
```

This keeps the capability close to account-scoped trading/order behavior and avoids implying that public market metadata determines a user's effective trading rate.
