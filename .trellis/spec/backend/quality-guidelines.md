# Quality Guidelines

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
    "test": "bun test"
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
  - 用于统一跑 Bun 测试

#### 3.2 lint 工具约定

- 当前仓库统一使用 `Biome`。
- `lint:fix` 只用于本地修复，不替代 `lint`。
- `Biome` 规则至少要覆盖：
  - 禁止 `console.*`
  - 禁止非空断言 `!`

#### 3.3 finish-work 的通过条件

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
    "test": "bun test"
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

- 三个命令都能从干净环境直接执行
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
    "test": "bun test"
  }
}
```

效果：

- 项目质量入口固定
- `finish-work` 可以直接执行
- 后续 CI 也能复用同一组命令
