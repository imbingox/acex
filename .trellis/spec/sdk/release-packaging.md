# Release And Packaging

## Scenario: 仓库需要一个基于 Changesets 和 npm Trusted Publishing 的自动 beta + 手动 stable 发布流程

### 1. Scope / Trigger

- Trigger: 新增或修改 `.github/workflows/*` 中的 release workflow、调整 Changesets 版本脚本、修改 npm publish 参数、切换 prerelease/tag 策略、或变更 Trusted Publishing 约束时。
- 目标: 保持版本管理、release PR、npm publish、git tag 和质量门禁收敛在一条可审计流程里。

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
  workflow_dispatch:
    inputs:
      reenter_beta_mode:
        type: boolean
```

当前 release workflow 命令：

```bash
bun install --frozen-lockfile
bun run lint
bun run type-check
bun run test
bun run pack:check
bun run version-packages
bun --silent run release:notes <version>
bun run release
git push --follow-tags
gh release create <tag>
```

当前关键脚本：

```bash
bun run changeset
bun run version-packages
bun run changeset:pre:exit
bun run changeset:pre:enter:beta
bun run pack:check
bun --silent run release:notes
bun run release
```

当前 npm package `files` contract：

```json
[
  "index.ts",
  "src/",
  "docs/",
  "README.md",
  "CHANGELOG.md"
]
```

当前 `version-packages` contract：

```bash
changeset version && files="package.json"; if [ -f .changeset/pre.json ]; then files="$files .changeset/pre.json"; fi; if [ -f CHANGELOG.md ]; then files="$files CHANGELOG.md"; fi; biome check --write $files
```

### 3. Contracts

#### 3.1 触发方式

- release workflow 必须在 `main` 上自动运行。
- 正常 beta 发布流程不依赖手动 `workflow_dispatch`。
- `workflow_dispatch` 只允许作为 stable 正式发布入口，不能替代主线 beta 自动发布。
- stable 手动发布必须从 `main` 触发，不能从 feature branch / tag 触发。
- 版本来源必须是 `.changeset/*.md`，不是人工手改 `package.json.version`。

#### 3.2 分支限制

- release workflow 只监听默认分支 `main`。
- feature branch / PR branch 不应直接发布 npm 包。
- bot 为 stable 发布写回 `main` 的 commit message 必须带 `[skip release]`，避免再次触发 beta publish 逻辑。

#### 3.3 Trusted Publishing 与权限

- npm 发布认证优先使用 **Trusted Publishing**，不依赖长期 `NPM_TOKEN`。
- workflow 发布时需要：
  - `contents: write`
  - `pull-requests: write`
  - `id-token: write`
- `id-token: write` 用于 npm Trusted Publishing / provenance。
- 发布 workflow 不应设置 `NPM_CONFIG_PROVENANCE=false`；Trusted Publishing 场景下 provenance 应显式保持启用，例如 `NPM_CONFIG_PROVENANCE=true`。
- `package.json.repository.url` 必须指向当前 GitHub 仓库，避免 npm publish 时被自动修正。
- 当前仓库应写成 `git+https://github.com/imbingox/acex.git`，与 npm package metadata 规范化结果一致。
- npm 包 settings 中 Trusted Publisher 绑定的 workflow 文件名必须是 `release.yml`。

#### 3.4 发布前质量门禁

- release workflow 必须复用仓库已有质量命令，而不是自写另一套检查逻辑。
- 发布前必须至少执行：
  - `bun run lint`
  - `bun run type-check`
  - `bun run test`
  - `bun run pack:check`
- `version-packages` 不能只跑裸 `changeset version`；必须在版本文件生成后立刻格式化存在的 `.changeset/pre.json`、`package.json`，以及存在时的 `CHANGELOG.md`，避免 beta/stable 发布时因为格式问题把 workflow 跑挂。
- `bun run pack:check` 必须在 `changeset publish` 前运行，用真实 npm tarball 预览确认必需发布文件；当前脚本硬性校验 `README.md`、`CHANGELOG.md` 与 `docs/`。
- npm `files` contract 必须包含 `docs/`，保证 README / docs index 链接到的用户文档随包发布；不能把 `.changeset/*.md`、`.trellis/spec/` 或 `todo/` 当成下游发布说明。

#### 3.5 Git tag contract

- 任何 npm 发布完成后，都必须执行 `git push --follow-tags`，把版本 tag 推回仓库。
- 自动 beta 发布和手动 stable 发布都必须满足这个约束。
- 不能只发布 npm 包而不推 git tag，否则仓库版本与 npm 版本会失去可追溯性。
- 创建 GitHub Release 前必须确认本地 `v<version>` tag 存在且指向当前 HEAD；若远端缺 tag，workflow 应创建/推送该 tag 后再执行 `gh release create --verify-tag`。
- 推送 tag 必须显式推送 `refs/tags/v<version>`，不能只依赖 `git push --follow-tags`，因为补建场景可能创建轻量 tag。
- 当前仓库使用 Changesets 默认 git tag 行为。
- 对当前这个单包根仓库，Changesets 默认 tag 仍然是 `v<version>`。
- beta 示例：`v0.1.0-beta.4`
- stable 示例：`v0.1.0`

#### 3.6 GitHub Release contract

- npm publish 成功并推送 tag 后，workflow 必须为同一个 `v<version>` tag 创建 GitHub Release。
- beta GitHub Release 必须标记为 prerelease；stable GitHub Release 必须标记为 latest。
- GitHub Release notes 必须来自 Changesets 生成的 `CHANGELOG.md` 对应版本小节，而不是只依赖 GitHub 自动 PR 摘要；workflow 写入 notes 文件时必须用 `bun --silent run release:notes <version>`，避免 Bun 的脚本命令回显进入 release notes。
- release notes 临时文件必须写到 `$RUNNER_TEMP`，不能被 stable release 的 `git add -A` 提交进仓库。
- 如果 beta npm 版本已经发布过但 GitHub Release 缺失，workflow 应允许跳过重复 npm publish 后补建 GitHub Release。
- 如果 stable npm 版本已经发布过但 GitHub Release 缺失，workflow 应跳过重复 npm publish，确保同版本 tag 存在并补建 stable GitHub Release。

#### 3.7 Changesets 与 beta / stable 策略

- 仓库当前使用 Changesets prerelease mode，tag 为 `beta`。
- 自动 beta 发布依赖 prerelease mode，本质上由 `changeset pre enter beta` 生成的 `.changeset/pre.json` 驱动。
- stable 手动发布时必须：
  - 先执行 `changeset pre exit`
  - 再执行 `changeset version`
  - 再发布正式包到默认稳定 tag
- `changeset pre exit` 后 `.changeset/pre.json` 会被删除，所以 `version-packages` 必须兼容该文件不存在。
- stable 发布成功后，如需继续 beta 节奏，workflow 应默认重新执行 `changeset pre enter beta` 并把新的 `.changeset/pre.json` 推回 `main`。
- stable workflow 必须可重入：当 `main` 已经包含 stable metadata 且 npm 版本已存在时，不得再次执行 `pre exit` / `version-packages` / `changeset publish`，只执行缺失的 tag、GitHub Release、beta pre-mode 补齐步骤。
- stable 发布完成并重新进入 beta 后，`.changeset/pre.json.initialVersions` 必须等于刚发布的 stable 版本；例如 `0.2.0` 发布后应记录 `0.2.0`，下一轮 `minor` changeset 才会进入 `0.3.0-beta.x`。
- 正常节奏下不要手改 `package.json.version` 来推进版本号：新增用户可见能力只写 `.changeset/*.md`，beta release PR 和 stable workflow 负责消费 changeset、生成版本、发布 npm、推送 tag、重新进入下一轮 beta。
- 只有在 npm 上已存在目标 stable 版本、且历史 prerelease 基线已错位时，才允许一次性人工修正 stable 版本；修正后必须立即发布、推送 tag、重新执行 `changeset pre enter beta`，把后续版本号重新交还给 Changesets 状态机。

#### 3.8 业务改动必须带 changeset

- 任何会影响 npm 用户的 PR 都必须包含一个新的 `.changeset/*.md`，不能只改代码不写 changeset。
- changeset 文件名使用 kebab-case，放在 `.changeset/` 根目录，例如 `.changeset/fresh-funding-rate.md`。
- changeset summary 必须写用户可理解的行为变化，不写内部实现流水账。
- 当前仓库处于 beta prerelease mode；feature PR merge 后会先生成 beta release PR，release PR merge 后才 publish beta 包。
- 不影响 npm 用户的纯内部维护可不写 changeset，例如 Trellis spec / journal、任务归档、`todo/`、测试 fixture 重排、无行为变化的注释整理。

Changeset bump 选择矩阵：

| 改动类型 | bump | 示例 |
|---|---|---|
| 新增 public API、新能力、新可观察字段 | `minor` | 新增真实资金费率数据流、给 public snapshot 增加 `status` 字段 |
| 向后兼容的行为修复 | `patch` | 修复 stop 后 snapshot status 与聚合 status 不一致 |
| 文档、测试、Trellis spec / 任务归档 / journal、todo | 无需 changeset | 只更新 `docs/*`、`.trellis/spec/*`、`.trellis/workspace/*` 或 `todo/*` |
| pre-1.0（0.x）阶段的破坏性 public contract 变更 | `minor` | beta 阶段改变 public snapshot 返回值语义；`major` 保留给 1.0 里程碑 |
| 破坏性 public contract 变更 | `major` | 删除/重命名 public API、改变返回值语义导致现有调用方必须改代码 |

当同一个 PR 同时包含多类用户可见变更时，选择最高级别 bump：`major > minor > patch`。例外：仓库仍处于 pre-1.0（0.x）beta 阶段时，破坏性 public contract 变更使用 `minor`，避免提前把版本推进到 1.0。

### 4. Validation & Error Matrix

| 场景 | 约定 |
|---|---|
| `main` 上存在未消费的 changeset | 创建或更新 beta release PR |
| beta release PR 被 merge，`hasChangesets == false` | 进入 beta npm publish + push tags 步骤 |
| 手动 stable workflow 从 `main` 触发 | 先 `pre exit` + `version`，再 publish stable + push tags |
| 当前单包根仓库下 tag 名称不符合 `v<version>` | 视为发布行为偏离当前 contract |
| Trusted Publisher 未在 npm 上配置 | `changeset publish` 失败，npm 拒绝认证 |
| workflow 关闭 provenance | 视为偏离 Trusted Publishing contract，应移除 `NPM_CONFIG_PROVENANCE=false` |
| `package.json.repository.url` 与 GitHub 仓库不一致 | Trusted Publishing 校验失败 |
| `bun run lint` / `type-check` / `test` 任一失败 | workflow 直接失败，不允许发布 |
| `bun run pack:check` 失败或 tarball 缺少 `README.md` / `CHANGELOG.md` / `docs/` | workflow 失败，不允许发布 |
| 当前 beta 版本已经发布过，又有无 changeset 提交落到 `main` | workflow 应跳过重复 publish，不能直接因为 version already exists 失败 |
| npm 版本已存在但对应 GitHub Release 不存在 | 跳过 npm publish，补建同 tag 的 GitHub Release |
| npm 版本已存在但远端 tag 不存在 | 在当前 release metadata commit 上创建 `v<version>` tag 并显式推送该 tag |
| npm 版本已存在且 GitHub Release 已存在，但 beta pre-mode 未恢复 | 跳过重复 publish/release，继续执行 `changeset pre enter beta` 和 metadata push |
| 想发布稳定版到默认稳定 tag | 不能只改 npm tag；必须先处理 prerelease mode 和版本策略 |
| stable 发布后没有重新进入 beta pre mode | 后续 `push main` 不应发 beta；必须补执行 `changeset pre enter beta` 并提交 `.changeset/pre.json` |
| `.changeset/pre.json.initialVersions` 不是最近 stable 版本 | 下一轮 beta 基线会错位；必须先修正 pre mode 状态，再合并新功能 changeset |
| npm 已存在 stable 目标版本但本地 pre exit 又生成同一版本 | 不得重复发布；需要选择下一个正确 stable 版本并把该例外记录到 release commit/changelog |
| PR 新增 public API / public type 字段但没有 `.changeset/*.md` | 视为 release contract 缺失，合并前必须补 changeset |
| PR 同时包含 feature 和 bug fix | changeset bump 选最高级别，例如 `minor` 覆盖 feature + fix |
| PR 只有文档、测试、Trellis spec / 归档或 todo | 可不写 changeset |
| 0.x beta 阶段的破坏性 public contract 变更写成 `major` | 视为版本策略偏离；应改为 `minor`，`major` 留给 1.0 里程碑 |

### 5. Good / Base / Bad Cases

#### Good

```md
---
"@imbingox/acex": minor
---

Add Binance funding rate market data stream with per-stream market data status.
```

适用：新增用户可见能力或 public 类型字段。

```yaml
on:
  push:
    branches:
      - main
  workflow_dispatch:
    inputs:
      reenter_beta_mode:
        type: boolean
```

```yaml
- uses: changesets/action@v1
- run: bun run lint
- run: bun run type-check
- run: bun run test
- run: bun run release
- run: git push --follow-tags
```

#### Base

- workflow 里先用 Bun 安装依赖、跑质量命令，再由 `changeset publish` 调用 npm，可以接受。
- beta release PR 仍由 Changesets action 自动创建，publish 步骤放在 action 之后自定义执行，可以接受。
- stable 正式发布走手动 `workflow_dispatch`，但 beta 自动发布仍由 `push main` 驱动，可以接受。
- stable workflow 发布后默认 `reenter_beta_mode=true`，并提交新的 `.changeset/pre.json`，可以接受。
- `0.2.0` stable 发布后 `.changeset/pre.json.initialVersions` 为 `0.2.0`，后续 `minor` 进入 `0.3.0-beta.x`，可以接受。
- PR 里同时有 feature、bug fix、docs 和 tests，只写一个覆盖用户可见变化的 changeset，可以接受。
- npm publish 后用同一个 `v<version>` tag 创建 GitHub Release，并从 `CHANGELOG.md` 对应小节生成 notes，可以接受。
- stable workflow 重新运行时发现目标版本已在 npm 上存在，跳过 npm publish 但继续补 tag / GitHub Release / beta prerelease metadata，可以接受。

#### Bad

```text
src/types/market.ts 新增 public 字段
src/managers/market-manager.ts 新增用户可见行为
# 但没有新增 .changeset/*.md
```

问题：

- merge 后 Changesets action 不会生成对应 release PR
- beta publish 可能不会包含这次用户可见变更的版本说明

```md
---
"@imbingox/acex": patch
---

Refactor market manager internals.
```

问题：

- 如果实际新增 public API / public 字段，`patch` 级别过低
- summary 没有描述用户可见能力

```yaml
- name: Publish stable
  run: npm publish
```

问题：

- 版本信息脱离 Changesets prerelease/stable 状态机
- 不会自动生成/推送 git tag
- 没有 `pre exit` / `pre enter beta` 切换
- 容易把默认分支状态和 npm 状态弄乱

### 6. Tests Required

每次改发布 workflow，至少执行：

```bash
bun run lint
bun run type-check
bun run test
bun run pack:check
bun --silent run release:notes <version>
```

检查点：

- workflow YAML 语法正确，路径固定在 `.github/workflows/`
- 仓库现有质量命令在本地可执行
- `bun run pack:check` 解析 `npm pack --dry-run --json`，缺少 `README.md`、`CHANGELOG.md` 或 `docs/` 时必须非零退出
- `bun --silent run release:notes <version>` 能提取 `CHANGELOG.md` 中对应版本小节且不包含 Bun 命令回显；找不到版本时必须失败
- 用户可见代码变更必须有 `.changeset/*.md`
- changeset bump 级别必须与 public contract 变化匹配；0.x beta 阶段的破坏性 public contract 变更使用 `minor`
- changeset summary 必须描述用户可见行为变化
- workflow 中引用的 script 名称与 `package.json` 保持一致
- `.changeset/config.json`、`.changeset/pre.json`、workflow 的 prerelease/stable 策略一致
- `package.json.repository.url` 与仓库远端一致
- beta/stable 发布后 git tag 会被 push 回远端
- beta/stable 发布后同一个 tag 会创建 GitHub Release
- npm 已发布但 tag 或 GitHub Release 缺失时，workflow 能补齐缺失产物且不重复 npm publish
- 当前仓库下 git tag 名称为 `v<version>`
- stable 发布后如继续 beta，`.changeset/pre.json.initialVersions` 等于刚发布的 stable 版本
- npm dist-tag 中 `latest` 指向最新 stable 版本，`beta` 指向最新 beta 版本

### 7. Wrong vs Correct

#### Wrong

```yaml
- name: Publish package
  run: npm publish
```

问题：

- 没有 Changesets release PR
- 没有 prerelease/stable 策略
- 没有 Trusted Publishing 依赖的 `id-token: write`
- 也没有发布前检查
- 还缺失 `git push --follow-tags`
- 没有 GitHub Release notes

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

- name: Push git tags
  run: git push --follow-tags

- name: Create GitHub Release
  run: gh release create "$TAG" --notes-file "$RUNNER_TEMP/release-notes.md" --verify-tag
```

效果：

- 版本变更来源清晰，可在 PR 阶段审阅
- 发布入口稳定且可审计
- 质量门禁和本地开发入口一致
- 自动 beta 发布和手动 stable 发布都可演进
