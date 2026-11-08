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


## Session 2: 引用块与列表项内嵌块的渲染与对齐
<!-- trellis-session: v=2 fp=529a52092b984580 -->

**Date**: 2026-10-10
**Task**: 引用块与列表项内嵌块的渲染与对齐
**Branch**: `main`

### Summary

补齐嵌套容器内的块级渲染的**规划与门禁**，本次不含产品代码。范围经两轮复核收窄为：纯引用块内的块级内容渲染、列表项内嵌块的缩进对齐；代码块不接管，callout 后置到单独任务。两个门禁 spike 均已通过，实施明确后置。

### Main Changes

- prd/design/implement 三件套：region 判别联合（table/quote）复用同一套 field/装饰/快速路径；引用块走整段 replace + MarkdownRenderer 渲染（只读，零新增写盘路径）；缩进用 CM6 行装饰
- 门禁 0.1 通过：引用块可接管且**不需要 Prec.highest**（纯引用块没有原生 widget 争区间，风险低于上一任务），不影响既有表格接管
- 门禁 0.2 通过：缩进**只有 margin-left: Npx !important 可行**；padding-left 只动文字不动背景盒，position/transform 会让盒子右侧溢出被 contain:paint 裁
- !important 的必要性与既有告诫的张力已记入 design.md 与 spec：宿主把 margin 写在级联层且带 !important，压过非 important 的 inline；限定只允许出现在'列表内代码块行'一处并须注释理由
- 规划期复核补记：design.md §2.1 的 kind 判别标签与既有 TableKind（'pipe'|'html'）撞名，实施前需先做封闭在表格路径内的机械改名
- 可复现性存档：探针插件、门禁 fixture、被引用的截图、CDP 探针脚本原在被 gitignore 覆盖的路径下（spike-vault/、.shots/、.scratch/），已收进 spikes/ 并互相改指；根目录 main.js 忽略规则锚定为 /main.js，避免归档的探针 main.js 被静默吞掉

### Git Commits

| Hash | Message |
|------|---------|
| `87800c4` | docs(task): 引用块渲染与嵌套块缩进的规划、研究与门禁结论 |

### Testing

- [OK] node scripts/acceptance.mjs —— AC1–AC13 仍 13/13（本次无产品代码改动，基线未动）
- [OK] 门禁 spike 0.1：widget 计数恒为 1，字面围栏/管道/标题/列表行数全为 0，三种时机稳定
- [OK] 门禁 spike 0.2：4/4 时机无漂移；原生语法高亮、语言标签、折叠指示器未受损

### Status

[..] **规划完成，实施未开始** —— 本次交付的是规划与门禁结论，产品代码零改动。
`task.json` 状态仍为 `planning`，未执行 `task.py start`。

### Next Steps

- **实施未开始**，下一步是阶段 1，不是收尾
- 下次从 implement.md 阶段 1 起：先做 kind→tableKind 改名，再泛化 region 模型（唯一一次动既有成功路径，阶段末是强回滚点）
- 阶段 2 引用块渲染 → 阶段 3 缩进对齐 → 阶段 4 护栏收尾
- 缺一张证据：门禁 0.1 的 AFTER 态截图漏拍，重跑时顺手补拍（BEFORE 态见 spikes/shots/probe4.png）


## Session 3: 引用块整段渲染与列表项内嵌块缩进：复核修复 + 验收收紧
<!-- trellis-session: v=2 fp=642c491cc299189c -->

**Date**: 2026-11-08
**Task**: 引用块整段渲染与列表项内嵌块缩进：复核修复 + 验收收紧
**Branch**: `main`

### Summary

15 条复核意见全部处置（2 条误报），修复围栏/front matter/callout/lazy/owner-line/长代码块缓存/点击进入等问题；AC17/AC17c/AC6/AC20 改为可证伪断言，真实 Obsidian 24/24，单测 63/63

### Main Changes

- QuoteWidget：MarkdownRenderer 渲染、Component 生命周期、ResizeObserver 高度上报、点击进入源码
- codeIndent：表格/引用 widget 用 padding-left、原生代码块用行装饰 margin-left !important，按围栏起始行缓存像素
- scanQuote：连续/嵌套/lazy/callout 跳过，围栏与 front matter 排除
- 验收：AC17 1px 上下界 + 子项之后用例；AC17c 可证伪零接管；AC6/AC20 点击坐标进正文；AC17 滚动采集防虚拟化漏测

### Git Commits

| Hash | Message |
|------|---------|
| `061efd2` | feat: 引用块整段渲染与列表项内嵌块缩进对齐 |
| `2d6f6c7` | docs(task): 引用块渲染与嵌套缩进的规划、验收与复核记录 |

### Testing

- [OK] node scripts/acceptance.mjs -> 24/24 连续两次通过
- [OK] npm test -> 63/63；npm run typecheck / npm run build 通过

### Status

[OK] **Completed**

### Next Steps

- 剩余边界：缩进代码块内的 > 误判、源码模式加载、主题切换后 padding 需重渲染、region 双扫描未合并


## Session 4: 表格拖拽多选与引用块拖拽选字
<!-- trellis-session: v=2 fp=154136ef0d612060 -->

**Date**: 2026-11-08
**Task**: 表格拖拽多选与引用块拖拽选字
**Branch**: `main`

### Summary

修复用户报告的两处手势问题:表格单元格支持拖拽矩形框选(拖回锚点收缩)+ Shift 单击,tooltip 可发现;引用块单击不切源码,拖拽用 CSS Custom Highlight 自绘选区并接管 copy,双击才进入源码。复核期发现并修复 CM6 虚拟化下的缩进丢失(widget 缩进缓存 + viewportChanged 重测,codeIndent 顶层才清缓存),验收探针改为真实 CDP 鼠标并修正光标/滚动错位与尾部 cm-gap 漏测。29/29 验收、63/63 单测通过。

### Git Commits

| Hash | Message |
|------|---------|
| `ed478c6` | feat: 表格拖拽多选与引用块拖拽选字 |

### Status

[OK] **Completed**


## Session 5: 引用块内表格可编辑
<!-- trellis-session: v=2 fp=83ff072bce72f59c -->

**Date**: 2026-11-08
**Task**: 引用块内表格可编辑
**Branch**: `main`

### Summary

引用块渲染完成后，把 MarkdownRenderer 产出的 <table> 与剥离 > 链后扫描到的表格按顺序配对，用与正文共享的 TableEditor 原地替换；写回仍只经 commitGrid，indent 为行首前缀（> / '  > ' / '> > ' / '>   '），每次写盘前用 posAtDOM 重解析偏移；配对数量或形状不符则整块保持只读。新增 model/innerTable.ts + 10 个单测，抽出 widget/tableEditor.ts，AC29–AC33 用 CDP 真实鼠标验证，34/34 验收、73/73 单测。

### Git Commits

| Hash | Message |
|------|---------|
| `674f850` | feat: 引用块内表格升级为可编辑表格 |

### Status

[OK] **Completed**


## Session 6: 表格编辑写回 Markdown 与导出 md
<!-- trellis-session: v=2 fp=0380b08211bd666d -->

**Date**: 2026-11-08
**Task**: 表格编辑写回 Markdown 与导出 md
**Branch**: `main`

### Summary

渲染层编辑不再把表格永久改写成 HTML：新增 serializePipe（可无损表示时写回 GFM 管道语法，合并等结构才降级 HTML）与 commitGrid.forcePipe，工具栏新增「转 MD」；新增纯函数 exportMarkdown 与「复制/导出为 Markdown」只读命令；单元格输入折叠换行保证单行；验收新增 AC34–AC38 并把 AC29–AC31 改为断言管道语法，39/39 通过；单测 104。

### Git Commits

| Hash | Message |
|------|---------|
| `67f5f8a` | feat: 表格编辑写回 Markdown 管道语法并支持导出 md |

### Status

[OK] **Completed**


## Session 7: 引用块双击定位到所点行
<!-- trellis-session: v=2 fp=b270232f14b68ec6 -->

**Date**: 2026-11-08
**Task**: 引用块双击定位到所点行
**Branch**: `main`

### Summary

双击渲染态引用块进入源码时，光标落在被点击内容对应的源码行：新增 quoteLineMap（projectQuoteLines / scanQuoteBlocks / resolveQuoteLine），把外层 blockquote 的元素子节点与源码顶层块顺序配对，列表项用直接 li 序号精确定位；块数或项数不一致一律回退到引用首行。projectQuoteLines 抽取为 innerTable 与双击定位共用的单一投影实现。单测 122；验收新增 AC40–AC42，42/42 通过。

### Git Commits

| Hash | Message |
|------|---------|
| `d214b86` | feat: 引用块双击定位到所点行 |

### Status

[OK] **Completed**
