# Juplend Venue 规范

## Scenario: DEX 借贷只读账户视图

### 1. Scope / Trigger

- Trigger: 新增或修改借贷类 venue（当前为 `juplend`）、`RegisterAccountInput` venue-specific 初始化参数、`BalanceSnapshot.lending` / `RiskSnapshot.lending`、或 polling private adapter。
- 目标: 让 DEX 借贷账户以 AccountManager 的统一快照 / 事件 / 状态接口暴露，但不引入链上写操作或私钥管理。
- 边界: Juplend 只接 account read-only；不接 market/order，不做 supply / borrow / repay / withdraw。

### 2. Signatures

Public API 必须显式区分不同 venue 的注册参数，不能退回到 `Record<string, unknown>`：

```ts
type RegisterAccountInput =
  | {
      accountId: string;
      venue: "binance" | "okx" | "bybit" | "gate";
      credentials?: AccountCredentials;
      options?: {
        timestamp?: number;
        recvWindow?: number;
      };
    }
  | {
      accountId: string;
      venue: "juplend";
      credentials?: AccountCredentials;
      options: {
        walletAddress: string;
        vaultId?: string;
        positionId?: string;
      };
    };
```

借贷扩展字段：

```ts
interface BalanceSnapshot {
  accountId: string;
  venue: Venue;
  asset: string;
  free: string;
  used: string;
  total: string;
  lending?: LendingBalanceFacet;
}

interface LendingBalanceFacet {
  supplied: string;
  borrowed: string;
  interest: string;
  netAsset: string;
  supplyAPY?: string;
  borrowAPY?: string;
}

interface RiskSnapshot {
  accountId: string;
  venue: Venue;
  netEquity?: string;
  riskEquity?: string;
  riskRatio?: string;
  riskLeverage?: string;
  lending?: LendingRiskFacet;
}

interface LendingRiskFacet {
  marginLevel?: string;
  healthFactor?: string;
  ltv?: string;
  liquidationThreshold?: string;
  totalCollateralUSD?: string;
  totalDebtUSD?: string;
}
```

### 3. Contracts

- `accountId`: SDK 内部自定义账户名，在单个 client 内唯一；不是 Solana 钱包地址。
- `options.walletAddress`: Juplend Borrow REST API 查询用 Solana 钱包地址；`GET /lend/v1/borrow/positions?users=<wallet>` 会返回该钱包下全部 borrow positions。
- `options.vaultId`: 可选本地过滤条件，只纳入匹配 `vaultId` 的仓位；REST reader 仍先按 `walletAddress` 拉取钱包仓位。
- `options.positionId`: 可选本地过滤条件，只纳入匹配 `nftId === positionId` 的仓位。
- Dynamic data: Jupiter Borrow REST API `GET https://api.jup.ag/lend/v1/borrow/positions?users=<wallet>`。
- Vault metadata / price / symbol: 使用 position 响应内嵌的 `vault` / token 字段。不要额外调用 Tokens V2 / Price V3 / lite vaults 做 enrich。
- Jup API config: `AccountRuntimeOptions.venues.juplend.jupApiKey` 可选；未显式配置时默认读取环境变量 `JUP_API`，用于请求 Jup 官方 Lend Borrow API。
- Balance aggregation: 多个 matching positions 按 `asset` 聚合成 `AccountSnapshot.balances: Record<asset, BalanceSnapshot>`。
- Public decimal contract: 所有公开数量 / 金额 / 比率字段都必须是 canonical decimal string；adapter 和 manager 内部可用 BigNumber 计算，但不得把 BigNumber 对象暴露到 `BalanceSnapshot`、`RiskSnapshot` 或 lending facets。
- Quantity mapping: REST position `supply` / `borrow` / `dustBorrow` 是对应 token base units。公开数量按 position 内嵌 vault token decimals 转 human amount：`supplied = supply / 10^supplyToken.decimals`；`borrowed = (borrow + dustBorrow) / 10^borrowToken.decimals`。
- Risk aggregation: `netEquity = totalCollateralUsd - totalDebtUsd`；`riskEquity = Σ(collateralUsd × liquidationThreshold) - totalDebtUsd`；`riskRatio = totalDebtUsd / Σ(collateralUsd × liquidationThreshold)`，分母为 0 时返回 `undefined`。
- Threshold normalization: `liquidationThreshold = 850` 解释为 `0.85`；小于等于 1 的值按小数原样使用。
- APY normalization: `supplyRate = 554` / `borrowRate = 513` 解释为 `0.0554` / `0.0513`。
- Polling: 默认 30s，可通过 `AccountRuntimeOptions.venues.juplend.pollIntervalMs` 覆盖。
- Polling result is a full account snapshot, not a partial update; each successful poll must replace balances/positions/risk so closed positions and vanished assets are cleared.
- Polling must be serialized; schedule the next poll only after the previous poll settles to avoid overlapping requests and stale out-of-order responses.

### 4. Validation & Error Matrix

| Condition | Error / Status |
|---|---|
| `venue: "juplend"` 缺 `options.walletAddress` | TypeScript 报错；JS 绕过时 bootstrap 抛 `ACCOUNT_BOOTSTRAP_FAILED`，message 包含 `options.walletAddress required` |
| `options.vaultId` 非 string | bootstrap 抛 `ACCOUNT_BOOTSTRAP_FAILED`，message 包含 `options.vaultId must be a string` |
| `options.positionId` 非 string | bootstrap 抛 `ACCOUNT_BOOTSTRAP_FAILED`，message 包含 `options.positionId must be a string` |
| Borrow positions API HTTP 失败 | account status 进入 `degraded`，`reason = "http_failed"` |
| `positionId` 没匹配任何 position | 返回空 balances，`risk` 为 `undefined` |
| 已有 position 后续关闭或不再匹配 `positionId` | 下一次 poll 全量替换为空 balances 且清空 risk |
| 对 Juplend 调 `createOrder/cancelOrder/cancelAllOrders` | 抛 `VENUE_NOT_SUPPORTED` |

### 5. Good / Base / Bad Cases

- Good: 同一 `walletAddress` 注册多个 `accountId`，每个账户传不同 `positionId` 或 `vaultId + positionId` 做本地过滤。
- Base: 只传 `walletAddress` 不传 `positionId`，SDK 聚合钱包下全部 Juplend positions。
- Bad: 把钱包地址塞进 `accountId` 并省略 `options.walletAddress`；这会破坏账户语义，且应被类型和 runtime 拦截。

### 6. Tests Required

- Type-level: `RegisterAccountInput` 对 Juplend 缺 `options.walletAddress` 使用 `@ts-expect-error`，`credentials` 可省略。
- Integration happy path: fake Borrow REST positions，断言 `BalanceSnapshot.lending` 按 asset 聚合，`RiskSnapshot.riskRatio` 公式正确，数量按 token decimals 归一化，APY 按 1e4 归一化。
- Integration position filter: 传 `options.positionId`，断言只聚合匹配 `nftId` 的单个仓位。
- Integration vault + position filter: 传 `options.walletAddress + options.vaultId + options.positionId`，断言只聚合匹配仓位。
- Integration replacement: 先返回非空 positions，再返回空 positions，断言 stale balances / risk 被清空。
- Integration polling scheduler: 设置 `pollIntervalMs` 小于 fake position read 延迟，断言最大并发请求数为 1。
- Integration error: 缺 walletAddress、HTTP 失败分别映射到稳定错误 / status。
- Live smoke: `scripts/live-juplend-account-smoke.ts` 支持 `--wallet-address`、`--vault-id`、`--position-id`、`--show-amounts`。

### 7. Wrong vs Correct

#### Wrong

```ts
await client.registerAccount({
  accountId: walletAddress,
  venue: "juplend",
});
```

问题：`accountId` 被误用为数据源地址，无法把同一钱包下不同 position 拆成不同逻辑账户，也缺少显式初始化参数。

#### Correct

```ts
await client.registerAccount({
  accountId: "jup-loop-a",
  venue: "juplend",
  options: {
    walletAddress,
    positionId: "101",
  },
});
```

好处：`accountId` 是策略侧逻辑账户 key，`walletAddress` 是数据源地址，`positionId` 是可选过滤条件，三者语义分离且可由 TypeScript 校验。

---
