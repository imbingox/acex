# review-findings-todo-doc：全库 review 问题清单固化为 docs todo

## Goal

把 2026-06-10 对 acex 全库（订单/行情/账户链路、协调器、HTTP/限流/时钟/错误基础层、Binance 适配器）的 review 发现固化成一份可执行的 todo 文档，放在 `docs/` 下，作为后续修复任务的统一入口和进度看板。

## What I already know

- review 已完成，发现按 P0/P1/P2 分级（P0 三项：cancelAllOrders 响应形状、REST/WS 竞态回退、listenKeyExpired 静默失效）。
- cancelAllOrders 的响应形状已通过 Binance 官方文档核实：`DELETE /papi/v1/um/allOpenOrders` 返回 `{"code": 200, "msg": "..."}` 对象，代码按数组 `flatMap` 处理是确定性 bug（文档级验证完成，live 验证步骤写入文档附录）。
- 项目定位：crypto 多交易所量化策略底层 SDK，HFT + LFT 双场景（评估标准按 HFT）。
- CLAUDE.md 约定：人类阅读的项目文档默认中文，技术名词保留英文。

## Requirements

- 新建 `docs/improvement-todo.md`，中文，todo/checklist 风格。
- 每个条目包含：问题描述、代码位置（file:line）、影响、修复方案、验证方式、优先级、状态 checkbox。
- 按优先级分组：P0（实盘正确性）→ P1（正确性收尾 / HFT 基础 / 多交易所扩展性）→ P2（功能缺口与工程项）。
- 附录：cancelAllOrders 的 live 验证操作步骤；review 覆盖范围与方法说明。
- 不修改任何 src 代码（本任务 docs-only）。

## Acceptance Criteria

- [ ] `docs/improvement-todo.md` 存在且包含 review 的全部发现（P0 3 项、P1/P2 完整）。
- [ ] 每个 P0/P1 条目都有可执行的修复方案与验证方式，引用了准确的 file:line。
- [ ] cancelAllOrders 附录包含：文档级验证结论 + live 验证完整步骤（含风险控制：远离盘口的小额 GTX 单）。
- [ ] `bun run lint` 通过（无新增告警）。

## Definition of Done

- docs 文档落盘，lint 绿。
- docs-only 变更，无需 changeset（不影响 npm 包消费者……`files` 字段只含 docs/api.md，新文档不进发布包，无 API 变化）。

## Decision (ADR-lite)

**Context**: 需要确定文档位置、文件名与组织方式。
**Decision**: 单文件 `docs/improvement-todo.md`（而非按优先级拆多文件）；checklist + 每条目小节式结构；不放入 `.trellis/spec/`（这是待办清单不是规范）。
**Consequences**: 单文件便于全局排序与进度一览；条目完成后在原地打勾并可在后续任务中链接对应 task 目录。

## Out of Scope

- 任何 src/tests 代码修复（每个 P0/P1 条目后续单独立任务）。
- live smoke 实际执行（验证步骤写入文档，由持有 API key 的人执行）。

## Technical Notes

- review 证据链：order-manager.ts:1512（applyCommandUpdate 绕过 watermark）、private-adapter.ts:530/857/942、async-event-bus.ts:58、market-manager.ts:872/1183、rate-limiter.ts:44、runtime.ts:112-126 等，详见 todo 文档正文。
- Binance 官方文档（Cancel All UM Open Orders）响应示例：`{"code": 200, "msg": "The operation of cancel all open order is done."}`。
