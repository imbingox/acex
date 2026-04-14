# Cross-Layer Thinking Guide

> **Purpose**: Think through data flow across layers before implementing.

---

## The Problem

**Most bugs happen at layer boundaries**, not within layers.

Common cross-layer bugs:
- Adapter 返回的数据格式与 Manager 期望的不一致
- 交易所特定类型泄漏到领域层
- Manager 和 Runtime 职责边界模糊，状态散落在多处
- 多个 Manager 各自维护了本应由 Runtime 统一协调的逻辑

---

## SDK 层级边界速查

```text
Layer 4  公开 API     ← 调用方看到的接口
Layer 3  编排层       ← 生命周期、账户注册、健康聚合
Layer 2  领域层       ← 状态持有、事件发布、订阅逻辑
Layer 1  适配层       ← 交易所 WS/REST、特定类型
Layer 0  基础设施     ← AsyncEventBus, ManagedWebSocket, filters
```

| 边界 | 常见问题 |
|------|----------|
| 适配层 → 领域层 | 交易所特定类型泄漏（如 `BinanceMarketDefinition.family`） |
| 领域层 → 编排层 | Manager 直接依赖 Runtime 具体类而非 `ClientContext` 接口 |
| 编排层 → 领域层 | Runtime 承担了本应属于 Manager 的状态管理 |
| 公开 API → 内部 | 调用方依赖了深层内部路径而非根导出 |

---

## Before Implementing Cross-Layer Features

### Step 1: Map the Data Flow

画出数据在各层间的流向：

```
Exchange WS → Adapter(parse) → Manager(normalize+store) → EventBus → Consumer
```

对于每个箭头，问：
- 数据在这里是什么格式？
- 用什么接口/类型约束这个边界？
- 出错时谁负责处理？

### Step 2: Identify Which Layer Owns What

| 职责 | 归属 | 反模式 |
|------|------|--------|
| 交易所 WS URL 构建 | Adapter | 放在 Manager 里 |
| 原始消息解析为 `RawL1BookUpdate` | Adapter | 放在 Manager 里 |
| `RawL1BookUpdate` → `L1Book` 标准化 | Manager | 放在 Adapter 里 |
| Record Map / EventBus 持有 | Manager | 放在 Runtime 里 |
| 生命周期协调 (start/stop) | Runtime | 分散在 Manager 各自判断 |
| 健康状态聚合 | Runtime（调 Manager.getStatuses()） | Runtime 直接遍历 Manager 内部状态 |

### Step 3: 检查接口边界

- Adapter → Manager：通过 `MarketAdapter` 接口 + `L1BookStreamCallbacks`
- Manager → Runtime：通过 `ClientContext` 接口
- Runtime → Manager：通过 `ManagerLifecycle` / `AccountAwareManager` / `HealthReporter<T>` 接口

---

## Common Cross-Layer Mistakes

### Mistake 1: 适配器类型泄漏

**Bad**: Manager 代码中出现 `BinanceMarketDefinition`

**Good**: Manager 只使用标准 `MarketDefinition`，Adapter 内部持有扩展类型

### Mistake 2: Runtime 重新膨胀

**Bad**: 新功能的状态和逻辑放回 runtime.ts

**Good**: 状态放在对应 Manager，runtime 只做协调

### Mistake 3: Manager 依赖具体类

**Bad**: `import type { AcexClientImpl } from "../client/runtime.ts"`

**Good**: `import type { ClientContext } from "../client/context.ts"`

---

## Checklist for Cross-Layer Features

Before implementation:
- [ ] 画出了完整的数据流向
- [ ] 识别了每个层级边界
- [ ] 确认了边界处使用的接口类型
- [ ] 确认了状态归属（哪个 Manager 持有）

After implementation:
- [ ] 没有交易所特定类型泄漏到 Manager 或 Runtime
- [ ] Manager 通过 `ClientContext` 接口与 Runtime 交互
- [ ] Runtime 通过 `ManagerLifecycle` 等接口与 Manager 交互
- [ ] `bun run type-check` 通过（确保依赖方向正确）
