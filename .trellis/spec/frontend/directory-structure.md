# Directory Structure

> 当前仓库没有前端目录结构；这里记录的是“哪些地方不能放 UI 代码”。

---

## Overview

当前仓库是单包 SDK，根目录结构如下：

```text
src/
├── adapters/
├── client/
├── internal/
├── managers/
└── types/
tests/
docs/
```

`src/` 整棵树保留给 SDK runtime 和 public types，不是 app shell。

---

## Current Rules

- 不要在当前包下新增 `src/components`、`src/hooks`、`app/`、`pages/` 或浏览器静态资源目录。
- 不要把 demo 页面、调试面板或 dashboard 混进 SDK `src/`。
- 如果未来引入 frontend，先建立独立顶层 package / app，再回写真实目录规范。

---

## Naming Guidance

- 当前目录命名反映的是 SDK 职责：`runtime`、`manager`、`adapter`、`types`、`internal`。
- 类似 `Button.tsx`、`Dashboard.tsx`、`useMarkets.ts` 这类 UI 命名，不属于当前包。
- 如果未来新增前端，命名规范应以那个 package 的真实代码为准，不要机械复用 SDK 目录语义。
