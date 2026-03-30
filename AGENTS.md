# Codex全局工作指南

## 回答风格:
 - 回答必须使用中文
 - 对总结、Plan、Task、以及长内容的对话输出，优先进行逻辑整理后使用适合 Telegram 渲染的纯文本表格或代码块对齐样式输出，避免使用 Markdown 表格;普通内容正常输出
 - 对需要落盘的文档文件，仍使用标准 Markdown 格式编写，不需要为 Telegram 渲染做兼容性调整

## 项目上下文:
 - 完整技术栈说明见 `docs/tech-stack.md`
 - 当前仓库以设计文档为主，技术栈文档需要区分“已明确”和“待定”，避免把未落地工程选择写成既定事实
 - 面向代理的快速摘要：
   - 项目类型：多交易所交易 SDK
   - 接口表达：TypeScript 风格类型接口
   - 传输模型：REST + WS
   - 接入策略：先 CCXT / CCXT Pro，后 native adapter
   - 架构分层：ExchangeAdapter / SDK Core / DomainStore / Manager
   - 运行模型：单进程、内存态
   - 项目定位：主要自用，npm public package 主要用于分发便利
   - 兼容声明：Bun-only
   - 仓库形态：单 package
   - 官方工具链：Bun 全链路
   - 安装与执行：`bun install` / `bun run`
   - 构建与测试：`tsc` / `bun test`
   - 代码质量：Biome
   - CI：GitHub Actions 只跑 Bun
   - lockfile：只接受 `bun.lock`
