# Component Guidelines

> 当前仓库没有组件系统。

---

## Overview

`acex` 是程序化 SDK，不是 Web / Native 应用。目前仓库里没有 React、Vue 或 HTML 组件边界，因此不要凭空发明组件约定。

---

## Current Rules

- 不要在当前 SDK 包内新增组件文件。
- 不要把“顺手补个小面板 / demo 组件”包装成 SDK 功能的一部分。
- 如果未来引入第一方 frontend package，应基于那份真实代码重新定义组件规则。

---

## Future Boundary

如果未来真的有组件层：

- 组件 props 只依赖 public SDK exports。
- 不把 adapter / internal 细节透传到 props。
- 等出现至少两个真实组件以后，再在这里沉淀 composition 约定。
