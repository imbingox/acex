# Venue Lending Contract

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
      credentials: {
        apiKey: string;
      };
      options: {
        walletAddress: string;
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
  free: BigNumber;
  used: BigNumber;
  total: BigNumber;
  lending?: LendingBalanceFacet;
}

interface LendingBalanceFacet {
  supplied: BigNumber;
  borrowed: BigNumber;
  interest: BigNumber;
  netAsset: BigNumber;
  supplyAPY?: BigNumber;
  borrowAPY?: BigNumber;
}

interface RiskSnapshot {
  accountId: string;
  venue: Venue;
  equity?: BigNumber;
  riskRatio?: BigNumber;
  lending?: LendingRiskFacet;
}

interface LendingRiskFacet {
  healthFactor?: BigNumber;
  ltv?: BigNumber;
  liquidationThreshold?: BigNumber;
  totalCollateralUSD?: BigNumber;
  totalDebtUSD?: BigNumber;
}
```

### 3. Contracts

- `accountId`: SDK 内部自定义账户名，在单个 client 内唯一；不是 Solana 钱包地址。
- `options.walletAddress`: Juplend Portfolio API 查询用 Solana 钱包地址，必填。
- `options.positionId`: 可选 Juplend NFT position id；提供时只纳入 `data.link` 中 `/nfts/{positionId}` 匹配的仓位。
- Dynamic data: `GET https://api.jup.ag/portfolio/v1/positions/{walletAddress}?platforms=jupiter-exchange`，需要 `credentials.apiKey`。
- Static vault metadata: `GET https://lite-api.jup.ag/lend/v1/borrow/vaults`，缓存 TTL 1h。
- Position link: 从 `data.link` 抽取 `(vaultId, positionId)`，用 `vaultId` 关联 vault 元数据。
- Balance aggregation: 多个 matching positions 按 `asset` 聚合成 `AccountSnapshot.balances: Record<asset, BalanceSnapshot>`。
- Risk aggregation: `riskRatio = totalBorrowedValue / Σ(suppliedValue × liquidationThreshold)`；分母为 0 时返回 `undefined`。
- Threshold normalization: `liquidationThreshold = 850` 解释为 `0.85`；小于等于 1 的值按小数原样使用。
- Polling: 默认 30s，可通过 `AccountRuntimeOptions.juplend.pollIntervalMs` 覆盖。
- Polling result is a full account snapshot, not a partial update; each successful poll must replace balances/positions/risk so closed positions and vanished assets are cleared.
- Polling must be serialized; schedule the next poll only after the previous poll settles to avoid overlapping requests and stale out-of-order responses.

### 4. Validation & Error Matrix

| Condition | Error / Status |
|---|---|
| `venue: "juplend"` 缺 `credentials.apiKey` | TypeScript 报错；JS 绕过时 `subscribeAccount()` 抛 `CREDENTIALS_MISSING` |
| `venue: "juplend"` 缺 `options.walletAddress` | TypeScript 报错；JS 绕过时 bootstrap 抛 `ACCOUNT_BOOTSTRAP_FAILED`，message 包含 `options.walletAddress required` |
| `options.positionId` 非 string | bootstrap 抛 `ACCOUNT_BOOTSTRAP_FAILED`，message 包含 `options.positionId must be a string` |
| Portfolio API HTTP 失败 | account status 进入 `degraded`，`reason = "http_failed"` |
| Vault API HTTP 失败且有旧缓存 | 沿用旧缓存，继续输出账户视图 |
| Vault API HTTP 失败且无旧缓存 | bootstrap 失败，`ACCOUNT_BOOTSTRAP_FAILED` |
| `positionId` 没匹配任何 position | 返回空 balances，`risk` 为 `undefined` |
| 已有 position 后续关闭或不再匹配 `positionId` | 下一次 poll 全量替换为空 balances 且清空 risk |
| 对 Juplend 调 `createOrder/cancelOrder/cancelAllOrders` | 抛 `VENUE_NOT_SUPPORTED` |

### 5. Good / Base / Bad Cases

- Good: 同一 `walletAddress` 注册多个 `accountId`，每个账户传不同 `positionId`，策略可把单个 Juplend position 当作独立账户消费。
- Base: 只传 `walletAddress` 不传 `positionId`，SDK 聚合钱包下全部 Juplend positions。
- Bad: 把钱包地址塞进 `accountId` 并省略 `options.walletAddress`；这会破坏同钱包多账户分账能力，且应被类型和 runtime 拦截。

### 6. Tests Required

- Type-level: `RegisterAccountInput` 对 Juplend 缺 `credentials.apiKey` / `options.walletAddress` 使用 `@ts-expect-error`。
- Integration happy path: fake Portfolio + vaults，断言 `BalanceSnapshot.lending` 按 asset 聚合，`RiskSnapshot.riskRatio` 公式正确。
- Integration position filter: 传 `options.positionId`，断言只聚合匹配 `/nfts/{positionId}` 的单个仓位。
- Integration replacement: 先返回非空 portfolio，再返回空 portfolio，断言 stale balances / risk 被清空。
- Integration polling scheduler: 设置 `pollIntervalMs` 小于 fake Portfolio 延迟，断言最大并发请求数为 1。
- Integration error: 缺 API key、缺 walletAddress、HTTP 失败分别映射到稳定错误 / status。
- Live smoke: `scripts/live-juplend-account-smoke.ts` 支持 `--wallet-address`、`--position-id`、`--show-amounts`。

### 7. Wrong vs Correct

#### Wrong

```ts
await client.registerAccount({
  accountId: walletAddress,
  venue: "juplend",
  credentials: { apiKey },
});
```

问题：`accountId` 被误用为数据源地址，无法把同一钱包下不同 position 拆成不同逻辑账户，也缺少显式初始化参数。

#### Correct

```ts
await client.registerAccount({
  accountId: "jup-loop-a",
  venue: "juplend",
  credentials: { apiKey },
  options: {
    walletAddress,
    positionId: "101",
  },
});
```

好处：`accountId` 是策略侧逻辑账户 key，`walletAddress` 是数据源地址，`positionId` 是可选过滤条件，三者语义分离且可由 TypeScript 校验。
