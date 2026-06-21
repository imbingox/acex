# SDK Development Guidelines

本目录是 `acex` 的项目级工程规范入口。当前仓库是 Bun / TypeScript SDK，不使用 backend/frontend 分层；所有长期规则按 SDK 公共 API、runtime、manager、adapter、venue、测试、文档和发布边界组织。

## Scope

适用于：

- `src/` SDK 源码
- `index.ts` 根导出
- `tests/` 测试与 fixtures
- `scripts/` live smoke / release 辅助脚本
- `README.md`、`docs/*.md`、`todo/*.md`
- `.changeset/`、`package.json` 发布配置

## Guidelines Index

| Guide | When To Read |
|---|---|
| [architecture.md](./architecture.md) | 调整目录结构、层级依赖、runtime/manager/internal 边界 |
| [public-api.md](./public-api.md) | 修改 public types、根导出、decimal string、errors、venue capabilities |
| [client-runtime.md](./client-runtime.md) | 修改 `createClient()`、`AcexClient` 生命周期、venue runtime 选择、账户注册、health |
| [managers.md](./managers.md) | 修改 Market / Account / Order / Fee / RiskLimit manager 行为 |
| [adapters.md](./adapters.md) | 新增或修改 adapter、REST/WS transport、rate limiter、adapter callback |
| [venues/index.md](./venues/index.md) | 修改 venue-specific 行为或新增 runtime venue |
| [testing.md](./testing.md) | 新增测试、调整测试分层、运行质量门禁 |
| [docs.md](./docs.md) | 修改 README、`docs/*.md`、`todo/` 或文档打包配置 |
| [release-packaging.md](./release-packaging.md) | 修改 changeset、npm package files、release workflow 或发布语义 |

## Pre-Development Checklist

- 读本 `index.md`。
- 根据改动范围读取上表中的具体规范文件。
- 修改 venue-specific 行为时，额外读取 [venues/index.md](./venues/index.md) 和对应 venue 文件。
- 修改公共 API 时，同时读取 [public-api.md](./public-api.md)、[docs.md](./docs.md) 和 [release-packaging.md](./release-packaging.md)。
- 修改 adapter / transport / rate limit 时，同时读取 [adapters.md](./adapters.md)、[architecture.md](./architecture.md) 和相关 venue spec。
- 修改 manager 行为时，同时读取 [managers.md](./managers.md)、[public-api.md](./public-api.md) 和相关 venue spec。
- 始终读取 [.trellis/spec/guides/index.md](../guides/index.md)。

## Quality Check

- `bun run lint`
- `bun run type-check`
- `bun run test`

Docs-only changes may skip `type-check` / `test` when no code or package runtime behavior changed, but must still run `bun run lint` and relevant markdown link / package checks when links or package files changed.

## Current Conventions

- `docs/` 面向 SDK 使用方；adapter 接入流程、runtime 分层、基础设施 contract 和长期开发规则写在 `.trellis/spec/sdk/`。
- `todo/` 存放内部改进清单，不作为 npm 用户文档入口。
- README 只列当前 runtime-supported venue；type-only venue 只应出现在 public type reference 或能力 API 说明中。
- 新增 runtime venue 时必须同步 adapter capabilities、`docs/capabilities.md`、`venues/<venue>.md`、测试 fixture / live smoke 约定。
