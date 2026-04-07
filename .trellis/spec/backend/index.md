# Backend Development Guidelines

> 当前仓库的后端/Bun SDK 代码规范。这里写“实际已经采用”的组织方式，不写空泛原则。

---

## 概览

当前代码按以下层次组织：

- 包入口：`index.ts`
- 源码入口：`src/index.ts`
- 对外类型：`src/types/*`
- client runtime：`src/client/*`
- 领域 manager：`src/managers/*`
- 通用内部原语：`src/internal/*`

这些约束已经在当前 SDK skeleton 中落地，后续新增功能应沿用同一结构，不要把实现重新堆回单文件。

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Code Organization](./code-organization.md) | 目录、分层、拆文件边界、入口文件职责 | Active |
| [Quality Guidelines](./quality-guidelines.md) | lint/type-check/test 命令与静态质量约束 | Active |
| [Type Safety](./type-safety.md) | 类型定义位置、显式返回类型、避免宽化和循环引用 | Active |

---

## 当前约定

- `index.ts` 只做包级 re-export。
- `src/index.ts` 只做源码级 re-export。
- `src/client.ts`、`src/types.ts` 只保留兼容性聚合导出，不承载实现。
- 项目级检查命令统一使用 `bun run lint`、`bun run type-check`、`bun run test`。
- `market/account/order` 三个领域各自维护自己的类型和 manager。
- 共享状态记录、filter、clone helper 放在 `src/client/records.ts`。
- 与具体领域无关的事件原语放在 `src/internal/async-event-bus.ts`。

---

## 变更要求

当你修改以下内容时，先读对应规范：

- 调整目录结构、增加 manager、增加 runtime 层职责：读 [Code Organization](./code-organization.md)
- 修改 lint/type-check/test 命令、补质量规则：读 [Quality Guidelines](./quality-guidelines.md)
- 新增公共类型、修复类型错误、改返回值语义：读 [Type Safety](./type-safety.md)

---

**Language**: 本项目 spec 允许使用中文，优先写清楚可执行约束和实际例子。
