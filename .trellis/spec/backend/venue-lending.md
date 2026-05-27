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
      credentials?: AccountCredentials;
      options: {
        walletAddress?: string;
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
  netEquity?: BigNumber;
  riskEquity?: BigNumber;
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
- `options.walletAddress`: Juplend on-chain read 查询用 Solana 钱包地址；用于聚合该钱包下全部仓位。
- `options.vaultId + options.positionId`: 单仓直读模式；已知 vault + NFT position 时直接走 `getPositionByVaultId()`，不扫全钱包。
- `options.positionId`: 在 `walletAddress` 模式下可选，用于只纳入匹配 `nftId === positionId` 的仓位；在 direct read 模式下必填。
- Dynamic data: `@jup-ag/lend-read` 的 `Client.vault.getAllUserPositions(walletAddress)` 或 `Client.vault.getPositionByVaultId(vaultId, positionId)`。
- Vault metadata / price / symbol: 优先使用 Jup 官方 `Tokens V2 + Price V3` 补 token symbol / price；`GET https://lite-api.jup.ag/lend/v1/borrow/vaults` 仅作 vault fallback 信息。缓存 TTL 1h。
- RPC config: `AccountRuntimeOptions.juplend.rpcUrl` 可选；未显式配置时默认读取环境变量 `SOL_HELIUS_RPC`，再 fallback 到 SDK 默认 RPC。
- Jup API config: `AccountRuntimeOptions.juplend.jupApiKey` 可选；未显式配置时默认读取环境变量 `JUP_API`，用于请求 Jup 官方 `Tokens V2 + Price V3`。
- Balance aggregation: 多个 matching positions 按 `asset` 聚合成 `AccountSnapshot.balances: Record<asset, BalanceSnapshot>`。
- Quantity mapping: `lend-read` 返回的是 exchange-price-adjusted amount，不是 mint atomic amount。当前 ACEX 按固定 `1e9` scale 还原用户可见数量：`supplied = supply / 1e9`；`borrowed = borrow / 1e9`。`dustBorrow` 作为单独字段保留在 SDK 原始语义里，不重复并入公开 debt 数量。
- Risk aggregation: `netEquity = totalCollateralUsd - totalDebtUsd`；`riskEquity = Σ(collateralUsd × liquidationThreshold) - totalDebtUsd`；`riskRatio = totalDebtUsd / Σ(collateralUsd × liquidationThreshold)`，分母为 0 时返回 `undefined`。
- Threshold normalization: `liquidationThreshold = 850` 解释为 `0.85`；小于等于 1 的值按小数原样使用。
- APY normalization: `supplyRate = 554` / `borrowRate = 513` 解释为 `0.0554` / `0.0513`。
- Polling: 默认 30s，可通过 `AccountRuntimeOptions.juplend.pollIntervalMs` 覆盖。
- Polling result is a full account snapshot, not a partial update; each successful poll must replace balances/positions/risk so closed positions and vanished assets are cleared.
- Polling must be serialized; schedule the next poll only after the previous poll settles to avoid overlapping requests and stale out-of-order responses.

### 4. Validation & Error Matrix

| Condition | Error / Status |
|---|---|
| `venue: "juplend"` 缺 `options.walletAddress` 且缺 `options.vaultId + options.positionId` | TypeScript 报错；JS 绕过时 bootstrap 抛 `ACCOUNT_BOOTSTRAP_FAILED`，message 包含 `options.walletAddress or options.vaultId + options.positionId required` |
| `options.vaultId` 非 string | bootstrap 抛 `ACCOUNT_BOOTSTRAP_FAILED`，message 包含 `options.vaultId must be a string` |
| `options.positionId` 非 string | bootstrap 抛 `ACCOUNT_BOOTSTRAP_FAILED`，message 包含 `options.positionId must be a string` |
| lend-read RPC 失败 | account status 进入 `degraded`，`reason = "http_failed"` |
| Vault API HTTP 失败且有旧缓存 | 沿用旧缓存，继续输出账户视图 |
| Vault API HTTP 失败且无旧缓存 | bootstrap 失败，`ACCOUNT_BOOTSTRAP_FAILED` |
| `positionId` 没匹配任何 position | 返回空 balances，`risk` 为 `undefined` |
| 已有 position 后续关闭或不再匹配 `positionId` | 下一次 poll 全量替换为空 balances 且清空 risk |
| 对 Juplend 调 `createOrder/cancelOrder/cancelAllOrders` | 抛 `VENUE_NOT_SUPPORTED` |

### 5. Good / Base / Bad Cases

- Good: 同一 `walletAddress` 注册多个 `accountId`，每个账户传不同 `positionId`；或已知 `vaultId + positionId` 时直接注册单仓账户。
- Base: 只传 `walletAddress` 不传 `positionId`，SDK 聚合钱包下全部 Juplend positions。
- Bad: 把钱包地址塞进 `accountId` 并省略 `options.walletAddress`，同时又不给 `vaultId + positionId`；这会破坏账户语义，且应被类型和 runtime 拦截。

### 6. Tests Required

- Type-level: `RegisterAccountInput` 对 Juplend 缺 `options.walletAddress` 且缺 `options.vaultId + options.positionId` 使用 `@ts-expect-error`，`credentials` 可省略。
- Integration happy path: fake lend-read positions + vaults，断言 `BalanceSnapshot.lending` 按 asset 聚合，`RiskSnapshot.riskRatio` 公式正确，APY 按 1e4 归一化。
- Integration position filter: 传 `options.positionId`，断言只聚合匹配 `nftId` 的单个仓位。
- Integration direct read: 传 `options.vaultId + options.positionId`，断言走 `getPositionByVaultId()`，不触发全钱包扫描。
- Integration replacement: 先返回非空 positions，再返回空 positions，断言 stale balances / risk 被清空。
- Integration polling scheduler: 设置 `pollIntervalMs` 小于 fake position read 延迟，断言最大并发请求数为 1。
- Integration RPC config: 覆盖 `account.juplend.rpcUrl` 和 `SOL_HELIUS_RPC` 默认值。
- Integration error: 缺 walletAddress、RPC/HTTP 失败分别映射到稳定错误 / status。
- Live smoke: `scripts/live-juplend-account-smoke.ts` 支持 `--wallet-address`、`--position-id`、`--rpc-url`、`--show-amounts`。

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
