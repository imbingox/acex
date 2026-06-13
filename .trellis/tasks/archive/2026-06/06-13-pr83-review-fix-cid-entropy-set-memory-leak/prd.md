# PR83 review: 修复 cid entropy 模块级 Set 内存泄漏

## Goal

修复 PR #83 review finding：`src/managers/order/identity.ts` 的模块级 `sdkClientOrderIdEntropies` Set + `sdkClientOrderIdEntropyFallback` 造成无界内存泄漏（每个 `OrderManager` 构造时 add、永不删，累积到 36⁴≈167 万上限且永不回收）。

## 验证结论（已核实，2026-06-13）

- Finding **有效**：Set 在 `createSdkClientOrderIdEntropy()`（identity.ts:88-89/98-99）每次调用都 `.add()`，无任何 delete/清理；`createSdkClientOrderIdEntropy` 被 `order-manager.ts:117` 每个 manager 实例调一次。
- 引用范围全在 identity.ts 内部 + order-manager 一处调用，移除不影响外部契约。
- 修复方案合理：现有 `randomBase36Entropy()` 已是「crypto 随机整数 → mod SPACE → base36 → padStart(LENGTH)」，简化后 `createSdkClientOrderIdEntropy()` 直接返回它即可。

## Requirements

- 删除 `sdkClientOrderIdEntropies`（Set）与 `sdkClientOrderIdEntropyFallback`（计数器）及所有读写它们的代码（for 重试循环、while fallback 路径、Set has/add）。
- `createSdkClientOrderIdEntropy()` 简化为单次 crypto 安全随机：生成 `[0, SDK_CLIENT_ORDER_ID_ENTROPY_SPACE)` 随机整数 → base36 → padStart 到 `SDK_CLIENT_ORDER_ID_ENTROPY_LENGTH`（即直接 `return randomBase36Entropy()`）。
- 保留 `SDK_CLIENT_ORDER_ID_ENTROPY_LENGTH` / `SDK_CLIENT_ORDER_ID_ENTROPY_SPACE` 常量、`randomBase36Entropy` / `formatBase36Entropy` helper。
- cid 形态不变：`acex-<entropy4>-<ts36>-<seq36>`，≤32 字符，匹配 `VENUE_CLIENT_ORDER_ID_PATTERN`。

## Acceptance Criteria

- [ ] identity.ts 无任何 `sdkClientOrderIdEntropies` / `sdkClientOrderIdEntropyFallback` 引用。
- [ ] `createSdkClientOrderIdEntropy()` 无 for/while 循环、无 Set 操作，纯 crypto 随机。
- [ ] 现有 `tests/unit/order-manager-cid.test.ts`（格式 / 长度≤32 / pattern / 两 manager 不同）通过。
- [ ] `bun run lint` / `type-check` / `test` 全绿。

## Trade-off（已知，接受）

移除 Set 去重后，同进程内两个 manager 的 entropy 碰撞概率从 0 变为 1/167 万（与跨进程一致，本就只能靠随机）。cid 单测 `not.toBe` 因此理论上有 1/167 万 flaky——实践可忽略，**保持 minimal、不改测试**。内存泄漏（确定性问题）优先于 1/167 万 的进程内碰撞（概率性、且叠加同毫秒同 seq 才触发）。

## Out of Scope

- 不改 cid 格式 / entropy 长度
- 不动测试（除非 gate 红）
- 无其他 finding

## Technical Notes

- 来源：PR #83 inline review comment（针对 commit `c2f07a3` 引入的 entropy 去重逻辑）
- 修复后 push 到 PR #83 分支 `codex/p2-batch1-engineering-cleanup`，无需新 changeset（内部实现，已有 minor changeset 覆盖 cid entropy 公开行为）
