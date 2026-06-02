---
"@imbingox/acex": patch
---

对外错误信息不再泄漏签名与密钥。请求失败时，错误的 `message` 与 URL 会对 `signature`、API key、`listenKey`、`token`、`passphrase` 等敏感 query 参数及对应的 JSON body 字段做脱敏（替换为 `[REDACTED]`），私有订阅 bootstrap 失败路径同样会对透传的错误信息脱敏。此前这些敏感值可能随错误信息进入日志。属向后兼容的行为修复，不改变公共类型与 API 形状。
