# Testing And Quality

## Scenario: Bun SDK 仓库必须提供可执行的 lint / type-check / test 命令

### 1. Scope / Trigger

- Trigger: 初始化项目、补工程脚手架、引入新检查工具、或 `finish-work` 因缺少命令而无法全绿时。
- 目标: 让仓库始终存在稳定的质量入口，AI 和人都能用同一组命令完成检查。

### 2. Signatures

当前项目级命令：

```json
{
  "scripts": {
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "type-check": "tsc --noEmit",
    "test": "bun test --max-concurrency=1 tests/unit tests/integration",
    "test:unit": "bun test tests/unit",
    "test:integration": "bun test --max-concurrency=1 tests/integration",
    "test:soak": "bun test --max-concurrency=1 tests/soak",
    "test:all": "bun run test && bun run test:soak",
    "test:live:market": "bun run scripts/live-market-smoke.ts",
    "test:live:market:smoke": "bun run scripts/live-market-smoke.ts --duration 10",
    "test:live:market:soak": "bun run scripts/live-market-smoke.ts --duration 60 --disconnect-after 5 --disconnect-target perp",
    "test:live:account": "bun run scripts/live-account-smoke.ts",
    "test:live:account:smoke": "bun run scripts/live-account-smoke.ts --duration 10",
    "test:live:account:soak": "bun run scripts/live-account-smoke.ts --duration 60 --disconnect-after 5",
    "test:live:order": "bun run scripts/live-order-smoke.ts",
    "test:live:order:smoke": "bun run scripts/live-order-smoke.ts --duration 10",
    "test:live:order:soak": "bun run scripts/live-order-smoke.ts --duration 60 --disconnect-after 5",
    "test:live:order:listen-key": "bun run scripts/live-order-smoke.ts --duration 60 --expire-listen-key-after 5",
    "test:live:juplend": "bun run scripts/live-juplend-account-smoke.ts",
    "test:live:juplend:smoke": "bun run scripts/live-juplend-account-smoke.ts --duration 35 --show-amounts"
  }
}
```

当前质量配置文件：

```text
biome.json
package.json
```

### 3. Contracts

#### 3.1 必须存在的检查命令

- `bun run lint`
  - 用于统一跑格式和静态 lint 规则
- `bun run type-check`
  - 用于统一跑 TypeScript 类型检查
- `bun run test`
  - 用于统一跑默认 Bun 测试，只包含 `tests/unit/` 和 `tests/integration/`。
  - 当前脚本固定为 `bun test --max-concurrency=1 tests/unit tests/integration`。
  - `--max-concurrency` 控制的是并发测试的同时执行上限；默认集成测试依赖全局 `fetch` / `WebSocket` mock、共享 `FakeWebSocket` 状态，以及 `stopAllClientsForTests()` 全局清理。
  - 实测在启用并发测试时会出现超时、全局 mock 污染和 client 被其他测试提前停止的问题；除非先完成测试隔离，否则不要去掉集成测试入口的 `--max-concurrency=1`，也不要绕过 `bun run test` 直接改用其他默认入口。
- `bun run test:unit`
  - 只跑 `tests/unit/`，用于无真实网络、无交易所 fixture 的底层测试。
- `bun run test:integration`
  - 只跑 `tests/integration/`，用于 fake REST + fake WebSocket 的 SDK 跨层测试。
  - 必须保留 `--max-concurrency=1`，原因同默认 `bun run test`。
- `bun run test:soak`
  - 只跑 `tests/soak/`，用于 60 秒级连续更新、重连或长稳态验证。
  - 不进入默认 `bun run test` / PR CI / release workflow。
- `bun run test:all`
  - 本地完整验证入口，等价于默认快速测试 + soak。
- `bun run test:live:*`
  - 真实网络 / 真实凭证 smoke 入口，必须由人显式执行。
  - 不进入默认 `bun run test`、`test:all`、PR CI 或 release workflow。

#### 3.2 测试目录约定

- `tests/unit/`：底层工具、纯逻辑、无全局 mock 污染的单元测试。
- `tests/integration/`：SDK public API / manager / adapter 通过 fake infra 串起来的跨层测试；这是默认 CI 的主覆盖面。
- `tests/soak/`：长时间稳定性测试，例如 60 秒连续 L1 book 更新；只能通过 `test:soak` 或 `test:all` 显式执行。
- `tests/support/test-utils.ts`：通用 fake WebSocket、事件等待、response helper 和全局清理。
- `tests/support/exchanges/<exchange>.ts`：交易所专用 REST/WS fixtures 与 installer。新增交易所时不要把 payload 和 URL 写进通用 helper。

#### 3.3 CI 约定

- `.github/workflows/ci.yml` 是 PR / push main 的快速质量门禁。
- CI 必须运行 `bun run lint`、`bun run type-check`、`bun run test:unit`、`bun run test:integration`。
- CI 不运行 `test:soak` 或任何 `test:live:*`，避免 60 秒级等待、真实网络和凭证依赖阻塞 PR。
- `.github/workflows/release.yml` 继续运行 `bun run test`，即默认快速测试，不包含 soak/live。

#### 3.4 lint 工具约定

- 当前仓库统一使用 `Biome`。
- `lint:fix` 只用于本地修复，不替代 `lint`。
- `Biome` 规则至少要覆盖：
  - 禁止 `console.*`
  - 禁止非空断言 `!`

#### 3.5 finish-work 的通过条件

- `finish-work` 中的 “Code Quality” 默认对应：
  - `bun run lint`
  - `bun run type-check`
  - `bun run test`
- 如果这些命令不存在，视为工程脚手架未完成，而不是“暂时跳过”。

### 4. Validation & Error Matrix

| 场景 | 正确做法 | 错误做法 |
|---|---|---|
| 仓库新增 lint | 在 `package.json` 中提供 `lint` script | 只在对话里说“以后可以加” |
| 需要自动修复格式 | 提供 `lint:fix` | 把 `lint` 直接做成自动写入 |
| 检查类型 | `type-check: tsc --noEmit` | 继续依赖临时 `bunx tsc --noEmit` |
| 检查控制台输出 | 由 `Biome` 规则统一兜底 | 只靠人工搜索 |
| 检查非空断言 | 由 `Biome` 规则统一兜底 | 只靠 code review 口头提醒 |

### 5. Good / Base / Bad Cases

#### Good

```json
{
  "scripts": {
    "lint": "biome check .",
    "type-check": "tsc --noEmit",
    "test": "bun test --max-concurrency=1 tests/unit tests/integration",
    "test:unit": "bun test tests/unit",
    "test:integration": "bun test --max-concurrency=1 tests/integration",
    "test:soak": "bun test --max-concurrency=1 tests/soak",
    "test:all": "bun run test && bun run test:soak",
    "test:live:market:smoke": "bun run scripts/live-market-smoke.ts --duration 10",
    "test:live:account:smoke": "bun run scripts/live-account-smoke.ts --duration 10",
    "test:live:order:smoke": "bun run scripts/live-order-smoke.ts --duration 10",
    "test:live:juplend:smoke": "bun run scripts/live-juplend-account-smoke.ts --duration 35 --show-amounts"
  }
}
```

```json
{
  "linter": {
    "rules": {
      "suspicious": {
        "noConsole": "error"
      },
      "style": {
        "noNonNullAssertion": "error"
      }
    }
  }
}
```

#### Base

- `README.md` 可以只保留最小命令说明。
- 只要 `package.json` 脚本稳定存在，文档先不展开也可以接受。

#### Bad

- 只有 `bunx biome check .` 的临时命令，没有 `lint` script
- `type-check` 依赖 shell alias 或个人环境，而不是项目脚本
- lint 规则不禁止 `console.*` 和非空断言，导致 `finish-work` 与自动检查脱节

### 6. Tests Required

每次修改质量脚手架，至少执行：

```bash
bun run lint
bun run type-check
bun run test
```

断言重点：

- 三个默认命令都能从干净环境直接执行
- `test:unit` / `test:integration` 可分别执行，且 `test:soak` 不被默认 `bun run test` 隐式执行
- lint 会在存在 `console.*` 或非空断言时失败
- 类型检查和测试命令不会依赖个人 shell alias

### 7. Wrong vs Correct

#### Wrong

```json
{
  "scripts": {
    "test": "bun test"
  }
}
```

问题：

- `finish-work` 无法执行 `lint` 和 `type-check`
- 工程质量入口不完整

#### Correct

```json
{
  "scripts": {
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "type-check": "tsc --noEmit",
    "test": "bun test --max-concurrency=1 tests/unit tests/integration",
    "test:unit": "bun test tests/unit",
    "test:integration": "bun test --max-concurrency=1 tests/integration",
    "test:soak": "bun test --max-concurrency=1 tests/soak",
    "test:all": "bun run test && bun run test:soak",
    "test:live:market:smoke": "bun run scripts/live-market-smoke.ts --duration 10",
    "test:live:account:smoke": "bun run scripts/live-account-smoke.ts --duration 10",
    "test:live:order:smoke": "bun run scripts/live-order-smoke.ts --duration 10",
    "test:live:juplend:smoke": "bun run scripts/live-juplend-account-smoke.ts --duration 35 --show-amounts"
  }
}
```

效果：

- 项目质量入口固定
- `finish-work` 可以直接执行
- 后续 CI 也能复用同一组命令
- 默认测试入口保持快速确定性，长稳态和真实网络测试必须显式执行

## 测试布局

- `tests/unit/`：工具、manager、parser helper 和隔离行为的确定性单元测试。
- `tests/integration/`：使用 fake REST + fake WebSocket 的 SDK 跨层测试。
- `tests/soak/`：长时间本地稳定性测试，不属于默认 `bun run test`。
- `scripts/live-*-smoke.ts`：真实网络 smoke 脚本，不属于默认 `bun run test`、`test:all`、CI 或 release。
- `tests/support/exchanges/<venue>.ts`：venue-specific fixtures 和 fake transport installer。
- live smoke 脚本必须留在默认 `bun run test` 之外，并要求显式环境变量或配置。

## 必需命令

项目质量门禁是 `bun run lint`、`bun run type-check` 和 `bun run test`。纯文档改动至少运行 `bun run lint`，并运行相关链接或 package 检查。
