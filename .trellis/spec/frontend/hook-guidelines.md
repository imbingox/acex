# Hook Guidelines

> 当前仓库没有 React-style hooks。

---

## Overview

这个 SDK 里确实有状态和生命周期，但它们由 managers、runtime 和基础设施原语实现，而不是框架 hooks。

---

## Current Rules

- 不要在当前包里新增 `use*.ts` 或 `use*.tsx`。
- 不要把 SDK 生命周期逻辑改写成 framework-specific abstraction。
- 如果调用方需要 `useL1Book` 之类的 hooks，应在自己的 frontend package 基于 public SDK API 实现。

---

## Current Stateful Reuse

- `src/client/runtime.ts` 负责生命周期编排
- `src/internal/managed-websocket.ts` 负责连接管理
- `src/internal/async-event-bus.ts` 负责异步事件分发

这些都不是 hooks，不应在当前包里套上 hooks 语义。
