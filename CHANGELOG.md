# @imbingox/acex

## 0.3.0-beta.1

### Minor Changes

- 9dad2f0: Add post-only limit order support and market order input normalization. Binance PAPI UM limit orders now map `postOnly: true` to `timeInForce=GTX`, and callers can normalize price and amount strings with `market.normalizeOrderInput()` before placing orders.

## 0.3.0-beta.0

### Minor Changes

- 680e315: Add strict-symbol market data aggregation APIs for markets, L1 books, and funding rates. Also update Binance USDⓈ-M funding mark price streams to use the current market websocket endpoint and default 3s `markPrice` stream.

## 0.2.0

### Minor Changes

- 5dcc3c1: Add Binance funding rate market data stream with per-stream market data status.
- baeab15: Add Binance PAPI private account and order support, including the first `createOrder`, `cancelOrder`, and `cancelAllOrders` APIs.

## 0.1.0-beta.4

### Minor Changes

- 5dcc3c1: Add Binance funding rate market data stream with per-stream market data status.

## 0.1.0-beta.3

### Minor Changes

- baeab15: Add Binance PAPI private account and order support, including the first `createOrder`, `cancelOrder`, and `cancelAllOrders` APIs.
