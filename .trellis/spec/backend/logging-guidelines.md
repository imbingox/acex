# Logging Guidelines

> 当前仓库没有正式接通的 logger 集成。保留此文档是为了让 Trellis workflow 指向有效路径，并明确说明：不要把“预留的 logging 选项”误当成已经落地的日志系统。

---

## Current Reality

- `CreateClientOptions.logger` / `logLevel` 目前只是预留字段，未接入 runtime。
- 仓库里没有 `pino`、`winston` 等日志库，也没有统一的日志管道。
- SDK 当前对外暴露的是 `client.events.errors()` 这类错误事件流，而不是成体系的 logger 实现。

---

## Current Rules

- 不要在源码里添加临时 `console.*` 作为长期日志方案。
- 不要把 `logger` / `logLevel` 预留字段写成“已经生效”的文档或实现。
- 如果需要观测内部异常，优先通过 `events.errors()`、health 状态流和测试 fixture 做验证。

---

## If Logging Is Introduced Later

如果未来任务明确要求接入日志系统：

1. 明确日志目标：调试、审计、用户可见诊断，还是生产观测。
2. 定义等级、结构化字段、热路径上的采样策略。
3. 用真实实现和真实约束回填本文件。
