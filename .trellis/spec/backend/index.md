# Backend Development Guidelines

> 当前仓库的后端/Bun SDK 代码规范。这里写"实际已经采用"的组织方式，不写空泛原则。

---

## 概览

当前代码采用 5 层架构，依赖方向严格向下：

```text
Layer 4  公开 API          src/index.ts, src/errors.ts
Layer 3  编排层            src/client/{runtime, create-client, context}.ts
Layer 2  领域层            src/managers/{market, account, order}-manager.ts
Layer 1  适配层            src/adapters/{types, binance/*}
Layer 0  基础设施          src/internal/{async-event-bus, managed-websocket, filters}.ts
         类型定义          src/types/*（跨层共享）
```

关键设计：
- **Manager 持有领域状态**（record Map、事件总线、工厂方法），不是空壳 facade。
- **Manager 通过 `ClientContext` 接口**访问 runtime 服务，不依赖具体类。
- **交易所适配器封装交易所细节**，对外只暴露标准 `MarketAdapter` 接口。
- **Runtime 是薄编排器**（~280 行），只做生命周期、账户注册、健康聚合。

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Code Organization](./code-organization.md) | 5 层架构、目录结构、接口契约、各层职责边界 | Active |
| [Type Safety](./type-safety.md) | 类型定义位置、显式返回类型、避免宽化和循环引用 | Active |

---

## 当前约定

- `src/index.ts` 直接从实际位置导出，**无中间 re-export 文件**。
- `src/types/*` 只放 public contract，不放实现。
- `src/internal/*` 只放领域无关原语，不能依赖上层。
- `src/adapters/*` 封装交易所特定实现，交易所特定类型不泄漏到外部。
- `src/managers/*` 各自持有领域状态，实现 `ManagerLifecycle` + `HealthReporter<T>` 接口。
- `src/client/runtime.ts` 只做编排，实现 `AcexClient` + `ClientContext` 接口。
- `src/client/context.ts` 定义内部契约接口（`ClientContext`、`ManagerLifecycle`、`AccountAwareManager`、`HealthReporter<T>`）。
- 项目级检查命令统一使用 `bun run lint`、`bun run type-check`、`bun test`。

---

## 变更要求

当你修改以下内容时，先读对应规范：

- 调整目录结构、增加 manager、增加适配器、修改层级依赖：读 [Code Organization](./code-organization.md)
- 新增公共类型、修复类型错误、改返回值语义：读 [Type Safety](./type-safety.md)

---

**Language**: 本项目 spec 允许使用中文，优先写清楚可执行约束和实际例子。
