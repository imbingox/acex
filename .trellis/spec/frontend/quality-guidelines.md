# Quality Guidelines

> 当前仓库没有 frontend package。这里的质量门禁重点是防止 UI 代码误入 SDK 包。

---

## Repository Quality Gates

当前项目级检查命令定义在 `package.json`：

- `bun run lint`
- `bun run type-check`
- `bun run test`

这些命令验证的是 SDK 包，不代表仓库已经建立了 frontend stack。

---

## Forbidden Patterns

- 把 frontend 文件直接加到 SDK `src/` 树下。
- 在没有显式 workspace / app 计划时，把 frontend-only tooling 塞进当前根包。
- 让 demo / dashboard / UI 代码 import SDK 私有实现。
- 把通用 AI 模板里的前端建议，当成当前项目已经采纳的规范。

---

## Required Patterns

- 若未来引入前端，先建立独立 package / app。
- UI 代码只消费 public SDK exports。
- 一旦出现真实前端代码，立即用真实规则覆盖本目录占位文档。
