# Frontend Development Guidelines

> 本插件运行在 Obsidian 的渲染进程（Electron + CodeMirror 6），因此归入 frontend 层。

---

## Overview

这里是**可执行契约**，不是原则性描述。每条规则都来自实测踩坑，违反它会产生**静默失效或数据损坏**。

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [CodeMirror Widgets](./codemirror-widgets.md) | 块级 widget 集成契约：`eq` / `ignoreEvent` / 高度同步 / 缓存重算 | ✅ 已沉淀 |
| [Data Safety](./data-safety.md) | 与用户笔记的唯一接触点的写入契约 | ✅ 已沉淀 |
| [Plugin Build](./obsidian-plugin-build.md) | 打包与生命周期约定：CM6 必须 external、版本对齐、插件不持久化启用 | ✅ 已沉淀 |
| [Testing](./testing.md) | 两层测试约定 + 会制造假阴性的环境陷阱 | ✅ 已沉淀 |
| [Directory Structure](./directory-structure.md) | 模块组织与文件布局 | 见 README |
| [Component Guidelines](./component-guidelines.md) | 组件模式 | 待填 |
| [Hook Guidelines](./hook-guidelines.md) | 自定义 hook | 待填（本项目未使用 React） |
| [State Management](./state-management.md) | 状态管理 | 待填（本项目用 CM6 StateField） |
| [Quality Guidelines](./quality-guidelines.md) | 代码标准、禁止模式 | 待填 |
| [Type Safety](./type-safety.md) | 类型模式 | 待填 |

---

## 优先级

遇到冲突时，按此顺序取舍：

1. **不损坏用户数据**（`data-safety.md`）
2. **不静默失效**（`codemirror-widgets.md` 的 Warning 段落）
3. **与宿主原生行为一致**（视觉与解析规则都对齐 Obsidian 自己的实现）
4. 代码简洁

---

## 相关

- 跨层数据流思考：`.trellis/spec/guides/cross-layer-thinking-guide.md`
- 代码复用思考：`.trellis/spec/guides/code-reuse-thinking-guide.md`
- 本项目有三层数据流：**md 源文本 ↔ TableGrid 模型 ↔ 渲染 DOM**，已知缺陷全部产生在层边界上。
