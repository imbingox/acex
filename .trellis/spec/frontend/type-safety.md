# Type Safety

> 当前仓库没有 frontend 类型层；这里定义的是未来 UI 代码可以从哪里导入类型。

---

## Overview

SDK 已经通过 `src/types/*` 和 `src/index.ts` 暴露 public contract。未来若有 UI 代码，只能依赖这些公开边界，不能直接碰实现细节。

---

## Current Rules

- UI 相关代码只能从 public exports 或 `src/types/*` 导入 SDK-facing types。
- 不要从 `src/internal/*`、`src/client/*` 或 adapter 私有文件导入类型。
- `BigNumber` 应保留到展示边界再格式化，不要过早转成 `number`。

---

## Current Public Type Sources

- `src/types/client.ts`
- `src/types/market.ts`
- `src/types/account.ts`
- `src/types/order.ts`
- `src/index.ts`
