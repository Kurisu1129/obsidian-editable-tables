# Research: 把「光标进出→替换 widget」套到多行引用块上的可行性（Q3）

- **Query**: 现有多行替换模式套到 blockquote 会遇到什么（粒度、闪烁、多行 `Decoration.replace` 限制）。
- **Scope**: internal（现有实现 `src/editor/field.ts`、`src/editor/region.ts`、`src/widget/tableWidget.ts` + Obsidian 原生行为对照）
- **Date**: 2026-10-10

## 结论优先

- 现有模式（`regionField` 缓存 region；`tableField` 造 `replace({block:true})`；选区碰到 region 就跳过装饰→还原源码；纯选区移动走快速路径）**可直接复用到引用块**，把「表格 region」换成「引用块 region」即可。
- **跨多行的 `Decoration.replace({block:true})` 完全可行**——Obsidian 自己就用它替换整段 callout（源码 `w({widget, side:1, block:!0}, G, K)`，`G..K` 跨全部 callout 行）和整段围栏代码块。**硬约束**：被替换区间必须**对齐到行边界**（`block:true` 装饰不能只覆盖一行的一部分）。
- **粒度**上 Obsidian 已有先例：整个 callout（可几十行）作为一个 replace 区间。长引用块同理，但高度大 → 光标进出时**文档高度剧变**，会有滚动跳动/闪烁，Obsidian 的 callout 也有同样表现。
- 最大的真实风险不是「能不能替换」，而是**每次光标移动都可能触发大区间重建**；必须沿用 `field.ts` 的快速路径（选区不碰任何 region 时不重建）。

---

## 1. 读懂现有实现

### `src/editor/region.ts`

`TableRegion`：`{ from, to, indent, kind, grid, source }`。`from/to` 是文档偏移，`to` = 末行的行尾（`state.doc.line(block.endLine+1).to`）。

### `src/editor/field.ts`

- `regionField: StateField<TableRegion[]>`：**仅 `tr.docChanged` 时** `buildRegions` 重扫（`update: (regions, tr) => tr.docChanged ? buildRegions(tr.state) : regions`）。
- `tableField: StateField<DecorationSet>`：
  - `update`：`if (!tr.docChanged && !tr.selection) return deco;` —— 无文档变化且无选区变化直接复用。
  - **快速路径**：纯选区移动时，若「移动前不碰任何 region」且「移动后也不碰」，返回原装饰集（`selectionTouches`）。
  - `buildDecorations`：逐个 region，若**任一**选区 range 与 `[from,to]` 相交（`range.from <= region.to && range.to >= region.from`）则 `continue`（不装饰→显示源码），否则压入 `Decoration.replace({ widget: new TableWidget(region), block: true }).range(from, to)`。
- `editableTablesExtension = Prec.highest(tableExtensionFields)`（`src/editor/index.ts`）——用于压过 Obsidian 顶层表格 widget。

**这套模型直接适用于引用块**：把「扫描表格」换成「扫描引用块区间」，装饰换成引用块 widget 即可。`eq` 契约（比较 `source`+`from`+`to`）、`ignoreEvent:true`、`ResizeObserver`、`destroy` 卸载，全部照 `codemirror-widgets.md` 的契约。

## 2. 跨多行 replace 的可行性（有原生先例）

`obsidian.asar` 证据（`../spikes/research-probes/asarall.cjs`）：

- callout：`C.push(w({ widget: o, side: 1, block: !0 }, G, K))`，`G..K` 覆盖 callout 全部行（多行）。
- 围栏代码块 widget：`C.push(w({ widget: v, block: !0 }, ue, a))`，`ue` 是起始行位置，`a` 是结束行位置。
- 表格 widget：`C.push(w({ widget: c, side: 1, block: !0, inclusiveStart: b }, Y, Q))`。

→ **多行块级 replace 是 CM6 支持并被 Obsidian 大量使用的**。`block:true` 要求区间从行首到行尾；本项目 `region.from/to` 已经是行对齐的。

## 3. 光标进出的表现 / 闪烁

实测 Obsidian 原生 callout（`../spikes/research-probes/q3.js`）：

- 光标在 callout 内：`cm-embed-block` 计数 0，正文全部还原为 `.cm-line`（源码）。
- 光标移开：`cm-embed-block cm-callout` 回归。

这是**同一个「进出切换」模型**，且切换是**同步发生在 dispatch 期间**（`codemirror-widgets.md` 的 Warning：装饰重算在 `view.dispatch` 期间同步执行）。含义：

- 切换会让整段区间在「一大块 widget」与「N 行源码」之间来回 → **文档高度剧变**。若光标恰好在区间边缘，可能伴随滚动跳动。原生 callout 因此也有同样观感（可接受）。
- 若不做快速路径，**每次移动光标都会重建整段引用块装饰**，长文档下会掉帧。`field.ts` 的快速路径正是为此，必须保留。

## 4. 引用块 region 的界定（实现前要注意的点）

- **区间范围**：从第一行 `> ` 到最后一个连续引用行（含 lazy 续行、空 `>` 行）。Obsidian 的语法模式用 `HyperMD-quote` / `HyperMD-quote-N` / `HyperMD-quote-lazy` 标记这些行（见 `quote-block-rendering.md`）。可据此扫描，或纯文本按「行首 `>` / lazy」扫描。
- **嵌套层级**：`> > x` 是 `HyperMD-quote-2`；列表内的引用是 `HyperMD-list-line-… HyperMD-quote-…`。整块接管时这些层级都要保留（渲染时复现引用条缩进）。
- **缩进**：若引用块嵌在列表项内，接管后的 widget 是 `.cm-content` 直接子节点，**拿不到列表缩进**（同 `container-indent.md` 的结论：widget 左边缘 = `.cm-content` 左边缘）→ 需 widget 自己按 `region.indent` / 邻居列表的 computed `padding-left` 补缩进。
- **含 callout 的引用块**：`> [!note] …` 目前被 Obsidian 整段接管（`cm-callout`）。若本插件也要接管，需 `Prec.highest` 压过它（机制同顶层表格，但**未实测**）。

## 5. 编辑体验设计要点（供设计阶段）

1. **粒度**：以「一个连续引用块」为一个 region（与 callout 粒度一致）。
2. **进/出**：光标触碰 region → 显示源码（整段）；离开 → widget。沿用 `selectionTouches`。
3. **内部表格可编辑**：若区域内含表格，widget 内可用现有 `TableWidget`（但写回要考虑嵌套位置 → `region.indent` 与行前缀 `> `）。
4. **只读渲染**：若只要「看起来对」，widget 内直接 `MarkdownRenderer.render` 整段引用源码（实测会输出 `<blockquote>…</blockquote>` 且内块全渲染）；若要可编辑表格，则需自建表格部分。
5. **高度**：渲染异步 → 占位 + `ResizeObserver` + `view.requestMeasure()`。

## Caveats / 未验证

- 未实测「本插件用 `Prec.highest` 覆盖 `cm-callout`」的稳定性。
- 未实测长引用块（几十行）进出切换的实际掉帧数值；只从模型推断风险。
- 未实测光标恰在引用块边缘时的滚动跳动幅度。
