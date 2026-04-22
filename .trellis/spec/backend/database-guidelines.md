# Database Guidelines

> 当前仓库没有数据库、ORM 或 migration 层。保留此文档是为了让 Trellis workflow 指向有效路径，并明确说明：不要在当前 SDK 包里假设存在数据库约定。

---

## Current Reality

- `src/` 中没有 `db/`、`database/`、`models/`、`repositories/` 等持久化目录。
- 依赖中没有 Prisma、Drizzle、TypeORM、Mongoose、SQLite 驱动等数据库栈。
- market / account / order 状态都只存在于内存中的 manager records，不落盘。

---

## Current Rules

- 不要把数据库访问、migration 或 ORM 模型直接引入当前 SDK 包。
- 不要为了“缓存快照”而偷偷引入本地持久化层。
- 如果调用方需要落盘、审计、回放或查询能力，应在 SDK 外部消费 public API 自行实现。

---

## If Persistence Is Introduced Later

如果未来任务明确要求引入数据库：

1. 先明确为什么必须在仓库内持久化，而不是由 SDK 调用方负责。
2. 先建立真实目录边界和技术选型。
3. 用实际代码结构回填本文件，不要继续保留占位描述。
