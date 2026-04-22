# Frontend Development Guidelines

> 当前仓库没有 frontend / UI package。保留这组文档是为了让 Trellis workflow 和脚本始终指向有效路径，同时明确告诉贡献者：不要在当前 SDK 包里发明前端架构。

---

## Current Reality

- `@imbingox/acex` 当前是单包 Bun SDK，不是应用仓库。
- 根目录 `src/` 只包含 SDK runtime 代码：`client/`、`managers/`、`adapters/`、`internal/`、`types/`。
- 仓库里没有 `.tsx` 文件、没有 `components/` / `app/` / `pages/`、也没有前端构建配置。
- 如果未来真的引入 frontend，需要先建立独立 package 或 app，再把这组占位文档改写成真实规范。

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | 当前哪些目录禁止放 UI 代码；未来若引入前端，应该如何建立独立边界 | Placeholder |
| [Component Guidelines](./component-guidelines.md) | 当前没有组件系统；防止在 SDK 包内引入组件约定 | Placeholder |
| [Hook Guidelines](./hook-guidelines.md) | 当前没有 React-style hooks；防止把 SDK 状态机改写成 hooks | Placeholder |
| [State Management](./state-management.md) | 当前状态由 SDK managers 持有；不是前端状态层 | Placeholder |
| [Quality Guidelines](./quality-guidelines.md) | 前端相关变更的质量门禁与禁用模式 | Placeholder |
| [Type Safety](./type-safety.md) | 未来 UI 代码的类型导入边界 | Placeholder |

---

## How To Use These Docs

如果你正在做普通 SDK 开发：

- 优先阅读 `../backend/` 和 `../guides/`。
- 把这里的文档当成“不要误加前端”的边界说明，而不是现成的前端规范。

如果任务真的要求新增 frontend：

1. 先确认前端代码不会直接落进当前 SDK `src/` 树。
2. 先建立独立 package / app 边界。
3. 用真实代码结构回填本目录文档，不要继续保留占位描述。

---

## Review Checklist

- 拒绝把 UI 文件直接加到当前 SDK `src/` 目录。
- 拒绝从 `src/internal/*`、`src/client/*` 或 adapter 私有实现直接喂给 UI。
- 拒绝把泛用 AI 模板里的前端栈，当成当前仓库已经采纳的规范。
- 如果新增 demo / dashboard / app，要求先建立明确的前端边界。
