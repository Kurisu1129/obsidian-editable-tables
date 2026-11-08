# 设计：引用块内表格可编辑渲染

## 1. 总体思路

引用块的内层内容目前由 `MarkdownRenderer` 一次性渲染成静态 DOM。要让其中的表格"像正文一样"，不重写 Markdown 渲染器，而是：

1. 用现有扫描器在**引用源码**里定位表格块（把 `>` 前缀剥掉后扫描，与渲染器看到的 Markdown 一致）；
2. 渲染完成后，把渲染结果里的 `<table>` 按**源码顺序**与扫描结果一一配对；
3. 用与正文完全相同的表格编辑器（从 `TableWidget` 中抽出的 `TableEditor`）替换那个 `<table>` 元素；
4. 编辑时复用 `commitGrid`，把该表格的源码行范围替换为 HTML——每行带原引用前缀，从而保持引用/列表/嵌套结构。

## 2. 模块边界

### 2.1 `src/widget/tableEditor.ts`（新增）

从 `TableWidget` 抽出可复用的编辑器：

```ts
export class TableEditor {
  readonly element: HTMLElement;               // .mdft-table（含工具栏 + 表格）
  constructor(view: EditorView, region: TableRegion, resolve?: () => TableRegion | null);
  destroy(): void;
}
```

- `region` 是**渲染时**捕获的表格区域（`from/to/source/indent/tableKind/grid`）。
- `resolve` 在**每次写盘前**返回当前有效的区域；不传则固定使用 `region`（正文表格走这条路，因为 `TableWidget.eq` 已保证偏移有效）。
- 内部逻辑原样迁移：`WidgetState`、单元格编辑/提交/Escape、拖拽与 Shift 多选、工具栏、`selectionMap`、`paintCell`。
- 所有 dispatch 前通过 `resolve()` 重新取 `from/to`，再交给 `commitGrid` 校验 `source`；失败则放弃。

`TableWidget.toDOM` 改为：创建 `TableEditor(this.view, this.region)`，套上 `.mdft-table` 外壳、`ResizeObserver`、`applyBlockIndent`，行为与现在逐字节等价。

### 2.2 `src/widget/quoteInnerTables.ts`（新增，纯函数为主）

```ts
export interface InnerTable {
  relFrom: number;      // 相对引用块 region.from 的起始偏移
  relTo: number;        // 相对结束偏移
  prefix: string;       // 首行的完整行首前缀，如 "> " / "  > " / "> > " / ">   "
  tableKind: TableKind;
  grid: TableGrid;
  source: string;       // 该表格在文档中的原始源码（含前缀）
}

export function scanInnerTables(
  doc: EditorState['doc'], quoteFrom: number, quoteStartLine: number,
  source: string, indent: string,
): InnerTable[]
```

算法：

1. `rendered = stripIndent(source, indent)`，按 `\n` 拆行——行数与引用源码行数一一对应。
2. 每行剥掉引用前缀 `^[ \t]*(?:>[ \t]?)+`，得到 `contentLines`；同时记录该行内容在原始行中的列偏移：
   - `base = line.startsWith(indent) ? indent.length : 0`；
   - `contentStart = base + 剥掉前缀后的内容起始列`。
3. `scanTableLines(contentLines)` → 表格块（0 基行号）；`parsePipeTable` / `parseHtmlTable` 解析网格。
4. 每个块映射到绝对位置：
   - `absStartLine = quoteStartLine + block.startLine`；
   - `from = doc.line(absStartLine + 1).from`，`to = doc.line(absEndLine + 1).to`；
   - `prefix = doc.line(absStartLine + 1).text.slice(0, contentStart[block.startLine])`；
   - `source = doc.sliceString(from, to)`；
   - `relFrom = from - quoteFrom`，`relTo = to - quoteFrom`。

要点：`prefix` 保留引用链 + 列表缩进，作为 `serializeHtmlTable(grid, prefix)` 的缩进参数，替换后每一行生成的 HTML 都带同样的前缀，引用结构与列表归属不变。

### 2.3 `QuoteWidget`（改动）

- `toDOM` 在 `MarkdownRenderer.render().then()` 里调用 `upgradeInnerTables()`：
  - `domTables = body.querySelectorAll('table')`（文档顺序）；
  - `innerTables = scanInnerTables(...)`；
  - **数量不等 → 不升级**（内嵌笔记等异步内容可能引入表格），`console.warn` 一次并保持只读；
  - 相等 → 逐个 `domTables[i].replaceWith(editor.element)`。
- 每个 `TableEditor` 的 `resolve`：
  ```ts
  () => {
    let base;
    try { base = view.posAtDOM(wrap, 0); } catch { return null; }
    return { ...captured, from: base + relFrom, to: base + relTo };
  };
  ```
  `captured.source/prefix/tableKind/grid` 不变；`from/to` 每次按当前 widget 位置重算，所以文档上方有编辑、widget DOM 被复用时仍然落在正确范围（`commitGrid` 的 `source` 校验兜底）。
- `destroy` 里销毁所有 inner editors。
- 事件排除：`isInteractive` 的 `closest()` 选择器加入 `.mdft-table`，并在交互目标上右键/按下时清除引用块自身的文字高亮；`dblclick` 同样不处理表格区域。
- `copy` 处理器的守卫加强：原生选区位于任何 `contenteditable`（表格单元格输入框）时不劫持复制。

## 3. 写回契约

- 唯一写盘路径仍是 `commitGrid(view, region, grid)`：
  - `region.from/to` 是**整行**（行首到行尾），包含 `>` 前缀；
  - `region.source` 是这整段行文本，作为"目标仍在原处"的校验；
  - `region.indent` 是**行首前缀**（可含 `>`），`serializeHtmlTable` 给每一行加同样的前缀。
- 正文表格的 `indent` 是空白；引用内表格的 `indent` 是 `"> "` 这类前缀。语义统一为"每行都要复现的行首字符串"，并更新 `region.ts` 的注释。
- 首次把 pipe 表格改写为 HTML 时复用 `discloseHtmlConversion` 一次性提示。

## 4. 失败与降级

| 情形 | 处理 |
|---|---|
| 渲染表格数 ≠ 扫描表格数 | 整块不升级，只读渲染，绝不猜测范围 |
| 表格不可解析（parse 返回 null） | 该表格保持静态，不进编辑器（数量仍按扫描块计，需从配对中排除并整体放弃升级以保持顺序安全） |
| `resolve()` 抛错 / 取不到位置 | 放弃本次写入 |
| `commitGrid` 的 source 校验失败 | 放弃写入（说明偏移已漂移） |
| widget 已销毁 | 不升级、不写 |

## 5. 兼容与风险

- **性能**：只在引用渲染完成后做一次 DOM 数量统计与替换；不改变 `QuoteWidget.eq`（仍只比 source+indent），避免上方每次击键重建引用块。
- **异步渲染**：`MarkdownRenderer` 的 Promise 完成后才升级；嵌入内容晚到引入的表格不会被升级（数量校验会兜底）。
- **嵌套深度**：扫描器把 `> >` 剥成一层扫描，DOM 中的表格顺序与源码顺序一致；配对按顺序即可。
- **围栏代码块**：扫描器自带 fence 排除，代码块里的管道符不会被当成表格。
- **交互冲突**：引用块的整体文字选中/复制/双击进源码与内嵌编辑器互斥由 `isInteractive` + copy 守卫保证。

## 6. 回滚

- 阶段 1（抽取 `TableEditor`）可独立验证：正文表格 AC1–AC13 全绿后再继续。
- 阶段 2（引用内升级）失败时移除 QuoteWidget 的升级调用即可回到"引用内表格只读"，写回路径与主表格不受影响。
