---
"@imbingox/acex": patch
---

private 编排层改为按 adapter capability 分派，移除残留的 venue 字面量：下单命令是否支持按 `orderCapabilities.supported`、订单订阅按 `orderCapabilities.updates`、private credentials 是否必需按 `accountCapabilities.credentialsRequired`、account stream 启动顺序按 `accountCapabilities.updates`（polling 先 bootstrap、websocket 先建流）、REST account refresh polling 按 adapter 是否实现可选的 `refreshAccount()` 判别。juplend 轮询间隔从内部 `PrivateStreamOptions` 收口进 adapter 构造。公开 API、公共类型与运行时行为均不变，为后续接入新交易所做准备。
