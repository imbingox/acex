# Release Publishing

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
bun run version-packages
bun run release
git push --follow-tags
```

当前关键脚本：

```bash
bun run changeset
bun run version-packages
bun run changeset:pre:exit
bun run changeset:pre:enter:beta
bun run release
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
- `package.json.repository.url` 必须和 GitHub 仓库 URL 精确匹配。
- 当前仓库应写成 `https://github.com/imbingox/acex`，不要写成 `git+https://...git` 形式。
- npm 包 settings 中 Trusted Publisher 绑定的 workflow 文件名必须是 `release.yml`。

#### 3.4 发布前质量门禁

- release workflow 必须复用仓库已有质量命令，而不是自写另一套检查逻辑。
- 发布前必须至少执行：
  - `bun run lint`
  - `bun run type-check`
  - `bun run test`
- `version-packages` 不能只跑裸 `changeset version`；必须在版本文件生成后立刻格式化存在的 `.changeset/pre.json`、`package.json`，以及存在时的 `CHANGELOG.md`，避免 beta/stable 发布时因为格式问题把 workflow 跑挂。

#### 3.5 Git tag contract

- 任何 npm 发布完成后，都必须执行 `git push --follow-tags`，把版本 tag 推回仓库。
- 自动 beta 发布和手动 stable 发布都必须满足这个约束。
- 不能只发布 npm 包而不推 git tag，否则仓库版本与 npm 版本会失去可追溯性。
- 当前仓库使用 Changesets 默认 git tag 行为。
- 对当前这个单包根仓库，Changesets 默认 tag 仍然是 `v<version>`。
- beta 示例：`v0.1.0-beta.4`
- stable 示例：`v0.1.0`

#### 3.6 Changesets 与 beta / stable 策略

- 仓库当前使用 Changesets prerelease mode，tag 为 `beta`。
- 自动 beta 发布依赖 prerelease mode，本质上由 `changeset pre enter beta` 生成的 `.changeset/pre.json` 驱动。
- stable 手动发布时必须：
  - 先执行 `changeset pre exit`
  - 再执行 `changeset version`
  - 再发布正式包到默认稳定 tag
- `changeset pre exit` 后 `.changeset/pre.json` 会被删除，所以 `version-packages` 必须兼容该文件不存在。
- stable 发布成功后，如需继续 beta 节奏，workflow 应默认重新执行 `changeset pre enter beta` 并把新的 `.changeset/pre.json` 推回 `main`。

### 4. Validation & Error Matrix

| 场景 | 约定 |
|---|---|
| `main` 上存在未消费的 changeset | 创建或更新 beta release PR |
| beta release PR 被 merge，`hasChangesets == false` | 进入 beta npm publish + push tags 步骤 |
| 手动 stable workflow 从 `main` 触发 | 先 `pre exit` + `version`，再 publish stable + push tags |
| 当前单包根仓库下 tag 名称不符合 `v<version>` | 视为发布行为偏离当前 contract |
| Trusted Publisher 未在 npm 上配置 | `changeset publish` 失败，npm 拒绝认证 |
| `package.json.repository.url` 与 GitHub 仓库不一致 | Trusted Publishing 校验失败 |
| `bun run lint` / `type-check` / `test` 任一失败 | workflow 直接失败，不允许发布 |
| 当前 beta 版本已经发布过，又有无 changeset 提交落到 `main` | workflow 应跳过重复 publish，不能直接因为 version already exists 失败 |
| 想发布稳定版到默认稳定 tag | 不能只改 npm tag；必须先处理 prerelease mode 和版本策略 |

### 5. Good / Base / Bad Cases

#### Good

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

#### Bad

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
bun test
```

检查点：

- workflow YAML 语法正确，路径固定在 `.github/workflows/`
- 仓库现有质量命令在本地可执行
- workflow 中引用的 script 名称与 `package.json` 保持一致
- `.changeset/config.json`、`.changeset/pre.json`、workflow 的 prerelease/stable 策略一致
- `package.json.repository.url` 与仓库远端一致
- beta/stable 发布后 git tag 会被 push 回远端
- 当前仓库下 git tag 名称为 `v<version>`

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
- 自动 beta 发布和手动 stable 发布都可演进
