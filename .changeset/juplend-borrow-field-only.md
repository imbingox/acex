---
"@imbingox/acex": patch
---

Fix Juplend lending balances and risk debt to derive borrowed amounts from the Borrow REST `borrow` field only. `dustBorrow` is no longer included in public borrowed amount, net asset, or risk debt calculations, and Juplend risk pricing now uses the position response token `price` field directly.
