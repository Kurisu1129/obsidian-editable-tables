# Research: 引用块渲染的省力路径评估（Q4）

- **Query**: 有没有更省的路径（只接管特定内层块？Obsidian 设置/API 直接打开？），最省且最稳的路径 + 理由 + 反例。
- **Scope**: internal（基于 `quote-block-rendering.md` / `blockquote-widget-editing.md` / `markdown-renderer-in-widget.md` 的实测）
- **Date**: 2026-10-10

## 结论优先

- **没有 Obsidian 设置或 API 能「直接打开引用块的块级渲染」**。决定点在各行的语法 prop（`quote-block-rendering.md` 证据 2），是模式产出，非配置。CssClass 也改不了。
- 三条候选路径，按「改动面」排序：

| 路径 | 覆盖 | 风险 | 适合 |
|---|---|---|---|
| **A. 只接管引用块内特定块**（围栏代码块 + 表格） | 部分 | 低 | 只想修最痛的两类 |
| **B. 整段接管引用块**（`MarkdownRenderer` 渲染整块） | 全部 | 中 | 追求与阅读视图一致 |
| **C. 整段接管 + 内层表格换成可编辑 widget** | 全部 + 可编辑 | 高 | 要编辑引用里的表格 |

- **推荐**：先做 **A**（最省、最稳、可增量验证）；若 PRD 要求「标题/列表」也渲染，则升到 **B**，并把 **C** 作为后续。理由见下。
- **反例提醒**：不要试图「只对引用块内的表格下装饰而保留 callout/其余由 Obsidian 管」——引用块行没有块级 prop，Obsidian 根本不管这些行，谈不上「共存」；而 callout 行被 Obsidian 整段接管，**无法对其内部下装饰**（`quote-block-rendering.md` Q5）。

## 路径 A：只接管引用块内的围栏代码块 + 表格

**做法**：扫描文档，识别「引用块内的围栏代码块区间」和「引用块内的管道表格区间」，对每个**子区间**下 `Decoration.replace({block:true, widget})`；其余引用行保持源码。

**为什么省**：
- 不需要复现引用块的渲染；只需在 widget 自己身上画一条左引用条 + 按 `region.indent` 做缩进。
- 区间小、多为 3–8 行 → 高度变化小，闪烁/掉帧风险低。
- 复用现有 `TableWidget`（表格）与一个简单的只读代码 widget（可用 `MarkdownRenderer.render` 渲染 ```` ```lang … ``` ````，或直接用 `renderMath`/`loadPrism` 之外的现成高亮——`MarkdownRenderer` 最省）。

**反例 / 局限**：
- 覆盖不全：引用块内的 **标题 / 列表 / 缩进代码块** 仍是源码 —— 若 PRD 的验收要求它们也渲染，A 不达标（PRD Goal 明确列了「列表/标题」）。
- **行前缀处理**：被替换的行含 `> ` 前缀；widget 要自己补引用条，否则视觉上脱离引用块。嵌套层级（`> >`、列表内引用）都要单独算缩进。

## 路径 B：整段接管引用块（推荐用于「全都要渲染」）

**做法**：把「一个连续引用块」当作一个 region（同 callout 粒度）。光标在外→`Decoration.replace({block:true, widget})`；光标在内→源码。

widget 内二选一：
- **B1**：直接把整段引用源码（带 `> ` 前缀）交给 `MarkdownRenderer.render` → 输出 `<blockquote>…</blockquote>`，内部标题/列表/表格/代码块**全部渲染**（实测，见 `quote-block-rendering.md` 证据 4）。**最省**，视觉与阅读视图一致。
- **B2**：剥掉 `> ` 前缀，渲染内层内容，再自行包 `<blockquote>`（可微调，但无必要）。

**为什么稳**：
- 与 Obsidian 原生 callout 完全同构（整段 replace + 光标进出还原），**无装饰优先级冲突**（纯引用块本来就没有原生 widget，不需 `Prec.highest`）。
- 复用现有 `field.ts` 模型与 `codemirror-widgets.md` 契约，改动集中在「扫描器」与「新 widget」。

**反例 / 风险**：
- 整段替换 → 长引用块高度大，进出切换有高度剧变（原生 callout 同样，可接受）。
- widget 内**不可编辑**（除非再叠路径 C）；用户想改引用里的文字要先让光标进入（还原源码）——这与现有表格的交互模型一致。
- 高度异步（`MarkdownRenderer`）→ 必须占位 + `ResizeObserver`。
- 嵌套缩进：widget 不带列表层级类，需按 `region.indent` / 邻居补缩进（`container-indent.md`）。

## 路径 C：在 B 之上让内层表格可编辑

**做法**：整段接管引用块后，widget 内**不用** MarkdownRenderer 渲染整块，而是：自行渲染时把表格部分替换成现有 `TableWidget`；或渲染后再把 `table` 元素升级为可编辑。
**代价**：写回要处理嵌套位置（`> ` 前缀 + 缩进）。复杂度最高。
**反例**：不要试图「让 Obsidian 管引用块其余部分、本插件只管表格」——两者在同一段源码上，Obsidian 对引用块内表格**根本不渲染**（无 prop），无法分工；而 callout 场景下行不通（内部无 `.cm-line`）。

## 关于 callout 内表格（Q5 的路径结论）

- 想让本插件表格进 callout，**唯一**是先「整段接管 callout」（`Prec.highest` 压过 `cm-callout`），再用 `MarkdownRenderer` 复现 callout DOM，最后替换内层表格。**不能只接管内部表格**（callout 正文无 `.cm-line`）。
- 这是路径 C 的一个特例，成本与风险最高，建议**后置**。

## Caveats / 未验证

- 未验证 `Prec.highest` 覆盖 `cm-callout` 的稳定性（顶层表格已验证）。
- 未实测路径 A/B 的 widget 在真实插件里的表现（本轮只验证了组件与机制）。
- 「引用块内缩进代码块/列表」的具体区域识别在嵌套（列表内引用、多层引用）下的边界，未穷举。
