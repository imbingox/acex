# State Management

> 当前仓库没有 frontend state store；状态由 SDK managers 持有。

---

## Overview

当前状态归属已经是 SDK 设计的一部分：

- runtime 生命周期状态在 `src/client/runtime.ts`
- market 快照和订阅状态在 `src/managers/market-manager.ts`
- account 状态在 `src/managers/account-manager.ts`
- order 状态在 `src/managers/order-manager.ts`

这些是 SDK 的领域状态，不是 UI 状态。

---

## Current Rules

- 不要在当前包里引入 Redux、Zustand、React Query 等前端状态库。
- 不要在 SDK 内再复制一层 manager-owned state。
- 视图层自己的筛选、选中、布局等状态，应留在未来的 frontend package。
