# Release Publishing

## Scenario: 仓库需要一个基于 Changesets 和 npm Trusted Publishing 的自动发布流程

### 1. Scope / Trigger

- Trigger: 新增或修改 `.github/workflows/*` 中的 release workflow、调整 Changesets 版本脚本、修改 npm publish 参数、切换 prerelease/tag 策略、或变更 Trusted Publishing 约束时。
- 目标: 保持版本管理、release PR、npm publish 和质量门禁收敛在一条可审计流程里。

### 2. Signatures

当前 workflow 落点：

```text
.github/workflows/release.yml
```

当前触发 contract：

```yaml
on:
  push:
    branches: [main]
```

当前 release workflow 命令：

```bash
bun install --frozen-lockfile
bun run lint
bun run type-check
bun run test
bun run version-packages
bun run release
```

当前关键脚本：

```bash
bun run changeset
bun run version-packages
bun run release
```

### 3. Contracts

#### 3.1 触发方式

- release workflow 必须在 `main` 上自动运行。
- 正常发布流程不依赖手动 `workflow_dispatch`。
- 版本来源必须是 `.changeset/*.md`，不是人工手改 `package.json.version`。

#### 3.2 分支限制

- release workflow 只监听默认分支 `main`。
- feature branch / PR branch 不应直接发布 npm 包。

#### 3.3 Trusted Publishing 与权限

- npm 发布认证优先使用 **Trusted Publishing**，不依赖长期 `NPM_TOKEN`。
- workflow 发布时需要：
  - `contents: write`
  - `pull-requests: write`
  - `id-token: write`
- `id-token: write` 用于 npm Trusted Publishing / provenance。
- `package.json.repository.url` 必须和 GitHub 仓库 URL 精确匹配。
- 当前仓库应写成 `https://github.com/imbingox/acex`，不要写成 `git+https://...git` 形式。
- npm 包 settings 中 Trusted Publisher 绑定的 workflow 文件名必须是 `release.yml`。

#### 3.4 发布前质量门禁

- release workflow 必须复用仓库已有质量命令，而不是自写另一套检查逻辑。
- 发布前必须至少执行：
  - `bun run lint`
  - `bun run type-check`
  - `bun run test`

#### 3.5 Changesets 与 beta 策略

- 仓库当前使用 Changesets prerelease mode，tag 为 `beta`。
- 自动发布时，npm dist-tag 当前固定为 `beta`。
- 如果未来要切正式版：
  - 先退出 Changesets prerelease mode
  - 再把 workflow 中的 npm tag 策略从 `beta` 调整到正式发布策略

### 4. Validation & Error Matrix

| 场景 | 约定 |
|---|---|
| `main` 上存在未消费的 changeset | 创建或更新 release PR |
| release PR 被 merge，`hasChangesets == false` | 进入 npm publish 步骤 |
| Trusted Publisher 未在 npm 上配置 | `changeset publish` 失败，npm 拒绝认证 |
| `package.json.repository.url` 与 GitHub 仓库不一致 | Trusted Publishing 校验失败 |
| `bun run lint` / `type-check` / `test` 任一失败 | workflow 直接失败，不允许发布 |
| 当前 beta 版本发布 | workflow 用 `NPM_CONFIG_TAG=beta` 发布 |
| 想发布稳定版到 `latest` | 不能只改 npm tag；必须先处理 prerelease mode 和版本策略 |

### 5. Good / Base / Bad Cases

#### Good

```yaml
on:
  push:
    branches:
      - main
```

```yaml
- uses: changesets/action@v1
- run: bun run lint
- run: bun run type-check
- run: bun run test
- run: bun run release
```

#### Base

- workflow 里先用 Bun 安装依赖、跑质量命令，再由 `changeset publish` 调用 npm，可以接受。
- release PR 仍由 Changesets action 自动创建，publish 步骤放在 action 之后自定义执行，可以接受。

#### Bad

```yaml
on:
  workflow_dispatch:
```

```yaml
- run: npm publish
```

问题：

- 版本信息脱离 Changesets
- 没有 release PR
- 没有 Trusted Publishing 约束
- 容易绕过仓库质量门禁

### 6. Tests Required

每次改发布 workflow，至少执行：

```bash
bun run lint
bun run type-check
bun test
```

检查点：

- workflow YAML 语法正确，路径固定在 `.github/workflows/`
- 仓库现有质量命令在本地可执行
- workflow 中引用的 script 名称与 `package.json` 保持一致
- `.changeset/config.json`、`.changeset/pre.json`、workflow 的 beta/tag 策略一致
- `package.json.repository.url` 与仓库远端一致

### 7. Wrong vs Correct

#### Wrong

```yaml
- name: Publish package
  run: npm publish
```

问题：

- 没有 Changesets release PR
- 没有 prerelease/tag 策略
- 没有 Trusted Publishing 依赖的 `id-token: write`
- 也没有发布前检查

#### Correct

```yaml
- name: Install dependencies
  run: bun install --frozen-lockfile

- name: Create release pull request or prepare publish
  uses: changesets/action@v1

- name: Run lint
  run: bun run lint

- name: Run type-check
  run: bun run type-check

- name: Run tests
  run: bun run test

- name: Publish package
  run: bun run release
```

效果：

- 版本变更来源清晰，可在 PR 阶段审阅
- 发布入口稳定且可审计
- 质量门禁和本地开发入口一致
- 当前 beta 发布和未来正式发布都可演进
