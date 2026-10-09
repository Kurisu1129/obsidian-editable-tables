# Journal - evans (Part 1)

> AI development session journal
> Started: 2026-09-16

---



## Session 1: 可编辑表格：列表嵌套渲染 + Live Preview 内可视化编辑
<!-- trellis-session: v=2 fp=482df87df785547b -->

**Date**: 2026-10-10
**Task**: 可编辑表格：列表嵌套渲染 + Live Preview 内可视化编辑
**Branch**: `main`

### Summary

以 md 为唯一真相，在 Live Preview 中接管表格渲染：嵌套在列表项内的表格（原生完全不渲染）与顶层表格统一接管为可编辑网格，支持增删行列/对齐/合并拆分与单元格原地输入，合并落盘为 GitHub 白名单内的 HTML <table>。

### Main Changes

- model/ 纯函数层：scan 锚定分隔行扫描（排除 front matter/代码围栏）、parsePipe（列宽取所有行最大值，与原生对齐）、parseHtml、serializeHtml、grid（增删行列/对齐/合并拆分 + 不变式归一化）
- editor/：两个 StateField（区域扫描仅在 docChanged 时重算 + 装饰，选区移动走快路径）；writeback 为唯一写盘点，带 source 新鲜度门禁
- widget/：Prec.highest 压过原生 cm-table-widget；工具栏置于 widget 盒内（宿主对块级 widget 强制 contain: paint !important，盒外元素不可见不可点）；单元格用 contenteditable
- 数据安全：只写被编辑过的表格；无法解析则拒绝渲染且不改写；front matter/代码围栏/未闭合 <table> 永不触碰
- 工程：CM6 与 lezer 全部 external（打包第二份 CM6 会导致 Decoration/StateField 类标识不一致，装饰被静默忽略），依赖锁定到 obsidian peerDependencies

### Git Commits

| Hash | Message |
|------|---------|
| `ffcf7cb` | feat: 可编辑表格 —— Live Preview 内渲染列表嵌套表格并支持可视化编辑 |

### Testing

- [OK] npm run typecheck 通过
- [OK] npm test —— 模型层 47/47 通过
- [OK] node scripts/acceptance.mjs —— CDP 驱动真实 Obsidian 1.12.7，AC1–AC13 全部 13/13 通过（含中文 IME 组合输入、只读零写入、front matter 逐字节不变）

### Status

[OK] **Completed**

### Next Steps

- 后续切片（不在本任务内）：列表项内嵌非表格块（代码块、引用）、callout 内表格修复
- 本仓库为本次新建，尚无 remote
