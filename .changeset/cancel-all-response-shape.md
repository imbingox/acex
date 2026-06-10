---
"@imbingox/acex": patch
---

Fix Binance `cancelAllOrders` parsing of the PAPI `{code,msg}` response as an order array, which previously always threw against the live API after the venue had already canceled the orders. The adapter now pre-fetches symbol open orders and returns them as canceled snapshots after the cancel-all response succeeds.
