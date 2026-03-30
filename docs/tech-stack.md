# 项目技术栈说明

> 本文档用于补齐当前仓库的技术栈上下文。
> 由于项目仍处于设计阶段，以下内容分为“已明确”和“待定”两类，避免把尚未拍板的实现选择写成既定事实。

## 1. 文档定位

本文档回答 3 个问题：

1. 当前设计文档已经明确了哪些技术选择。
2. 这些选择分别落在协议、架构、运行模型和工程约束的哪一层。
3. 还有哪些工程栈项尚未最终确定，需要在进入实现阶段前补齐。

相关文档：

- 对外 API：[`sdk-public-api.md`](./sdk-public-api.md)
- 内部实现设计：[`sdk-internal-design.md`](./sdk-internal-design.md)

## 2. 已明确的技术栈

### 2.1 语言与接口表达

- 语言层面按 TypeScript 风格设计，当前 API 与内部合同均以 `ts` 代码块定义。
- 对外 SDK 采用类型化接口设计，核心对象为 `AcexClient`、`MarketManager`、`AccountManager`、`OrderManager`。
- 异步模型使用 `Promise` + `AsyncIterable`。

这意味着：

- public API 会偏向强类型接口，而不是动态 JSON 协议。
- 事件消费模型采用异步迭代，而不是回调风格为主。

### 2.2 交易所接入与协议层

- 市场与私有数据链路采用 `REST + WS` 协同策略。
- steady state 以 WS 为主，bootstrap / reconcile 以 REST 为主。
- 交易所统一接入层为 `ExchangeAdapter`。
- 设计上优先通过 CCXT / CCXT Pro 跑通主流程，后续逐步演进到 native adapter。
- 交易对符号直接沿用 CCXT unified symbol，例如 `BTC/USDT`、`BTC/USDT:USDT`。

### 2.3 系统分层

当前已明确的逻辑分层如下：

1. `ExchangeAdapter`
2. `SDK Core`
3. `DomainStore`
4. `Manager`

职责边界已在内部设计文档中定义，重点是：

- adapter 负责交易所接入、字段标准化、能力暴露。
- Core 负责 bootstrap、freshness、reconcile、降级与恢复语义。
- Store 负责 latest snapshot 和控制面状态存储。
- Manager 负责对外稳定 API。

### 2.4 运行模型

- MVP 按单进程、内存态 SDK 设计。
- 当前不承诺分布式状态同步。
- 当前不承诺跨进程幂等与持久化去重。
- 账户标识在单个 `AcexClient` 实例内全局唯一。

### 2.5 数据与时间约定

- 金额、价格、数量统一使用 decimal string。
- 区分 `exchangeTs`、`receivedAt`、`updatedAt`、`ts` 等时间字段。
- 最新状态优先，查询返回当前最新快照，变化感知通过事件流完成。

### 2.6 当前 MVP 面向的能力范围

- 市场数据：L1 order book、funding rate、market info。
- 私有数据：balances、positions、risk、orders。
- 订单动作：place / cancel / cancel all / amend。
- 健康状态与恢复：`fresh`、`stale`、`degraded`、`reconnecting`、`reconciling` 等控制面状态对外可见。

### 2.7 开发与发布约束

- 项目主要供作者本人及其 Bun 技术栈下游应用使用。
- 发布到 npm public package 的主要目的是分发方便，而不是面向广泛 Node.js 生态提供兼容承诺。
- 对外兼容声明采用 `Bun-only` 口径。

这意味着：

- 项目默认按 Bun 工具链开发、测试、构建与发布。
- 当前不正式承诺 `Node.js`、`pnpm`、`npm` 作为开发或运行环境的兼容性。
- npm public package 只是分发渠道，不等同于提供 Node.js 兼容保证。

## 3. 已确定的工程栈决策

经过当前轮设计确认，工程栈决策如下：

### 3.1 仓库与包管理

- 仓库形态：单 package。
- 官方工具链：Bun 全链路。
- 依赖安装：`bun install`。
- 脚本执行：`bun run`。
- lockfile：只接受 `bun.lock`。

### 3.2 构建与产物

- 语言：TypeScript。
- 模块格式：ESM-only。
- 构建方式：`tsc` 编译发布。
- 发布形态：发布编译后的 `dist/` 产物，不直接把 TypeScript 源码作为包主产物。

### 3.3 测试与质量

- 测试框架：`bun test`。
- lint / format：Biome。
- CI：GitHub Actions 只跑 Bun。

### 3.4 发布与兼容口径

- 发包方式：`bun publish` 直接发布到 npm。
- 兼容声明：明确 `Bun-only`。
- README、文档与 issue 预期都应按 Bun 工具链组织，不再默认提供 Node / pnpm 的官方使用路径。

## 4. 当前仍待细化的工程项

核心方向已经确定，当前剩余的更多是“实现细节”，而不是“技术路线是否成立”的问题：

- `package.json` 的字段细节：`name`、`exports`、`files`、`packageManager`、`publishConfig`
- TypeScript 编译细节：`target`、`module`、`moduleResolution`、声明文件输出策略
- Biome 规则范围：只做基础规范，还是加入更严格的 lint 约束
- 测试覆盖范围：先覆盖 API 合同，还是同步补恢复/状态机场景
- 发布细则：版本号策略、tag 策略、是否维护 changelog

## 5. 当前可供代理快速使用的摘要

- 项目类型：多交易所交易 SDK
- 文档状态：设计先行，代码尚未落地
- 接口表达：TypeScript 风格类型接口
- 传输模型：REST + WebSocket
- 接入策略：先 CCXT / CCXT Pro，后 native adapter
- 架构分层：Adapter / Core / Store / Manager
- 运行模型：单进程、内存态
- 项目定位：主要自用
- 兼容声明：Bun-only
- 仓库形态：单 package
- 官方工具链：Bun 全链路
- 安装与执行：`bun install` / `bun run`
- 构建：`tsc`
- 测试：`bun test`
- 代码质量：Biome
- CI：GitHub Actions 只跑 Bun
- 发布：`bun publish` 到 npm public package
- lockfile：只接受 `bun.lock`
- 产物形态：ESM-only，发布 `dist/`
- 数据约定：金额价格使用 decimal string

## 6. 后续维护建议

- 当仓库出现真实工程文件后，应以实际落地配置回写本文档。
- `package.json` 落地后，应同步体现 `Bun-only` 口径，例如 `packageManager`、`exports`、`files`、发布配置等字段。
- README 与安装说明应直接说明：项目按 Bun 工具链开发和验证，npm 仅用于分发。
- 若后续重新决定支持 Node.js，应视为新的兼容策略变更，必须同步更新本文档、README、CI 和发包说明。
- 若实现偏离设计文档，应先更新设计文档，再同步更新本文档。
