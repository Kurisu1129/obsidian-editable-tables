# 设计：表格编辑写回 Markdown 与导出 md

## 1. 总体思路

渲染层（`TableEditor`）不变；改变的是**写回序列化策略**：

```
TableGrid ──canSerializePipe?──┬─ 是 ──> serializePipeTable(grid, indent)
                               └─ 否 ──> serializeHtmlTable(grid, indent)   （现状）
```

- **自动**：原始存储为 `pipe` 的表格，编辑后只要网格仍可管道化，就写回管道语法。
- **显式**：原始存储为 `html` 的表格，工具栏「转 MD」在可管道化时强制写回管道语法。
- **降级**：合并 / 跨行 / 无表头 / 多行单元格 → 仍写 HTML（管道语法无法表达）。
- **导出**：对笔记副本做一次纯函数转换，把可管道化的 HTML 表格改成管道语法，复制/下载；不写 vault。

这样"源文件是 Markdown"成为默认结果，HTML 只在结构上必须时出现。

## 2. 模块边界

### 2.1 `src/model/serializePipe.ts`（新增，纯函数）

```ts
export interface PipeCell {
  text: string;
  raw?: string;
  rowSpan: number;
  colSpan: number;
  covered: boolean;
}

/** 网格是否可以无损表示为 GFM 管道表格。保守：拿不准就 false。 */
export function canSerializePipe(grid: TableGrid): boolean;

/**
 * grid → GFM 管道表格的行。每行都带 indent 前缀。
 * 调用前必须 canSerializePipe(grid) === true；否则行为未定义（实现里会返回空数组）。
 */
export function serializePipeTable(grid: TableGrid, indent = ''): string[];

/** 测试/导出用：join('\n')。 */
export function serializePipeTableString(grid: TableGrid, indent = ''): string;
```

**可管道化条件**（全部满足才为 true）：

1. `grid.hasHeader === true`；
2. `grid.cells.length >= 1`，且每行列数等于网格宽度；
3. 每个单元格 `!covered && rowSpan === 1 && colSpan === 1`；
4. 每个单元格内容（`raw ?? text`）不含 `\r` / `\n`；
5. 每个单元格内容不含 `/(\\+)\|/`（反斜杠紧邻管道符；现有 `splitRow` 只识别 `\|`，无法无歧义往返）；
6. 若 `raw !== undefined`，`raw` 不含 `|`（HTML 标签/属性里的管道转义后会破坏标签）；
7. 内容为 `text` 时允许含 `|`，由序列化器转义。

**序列化**：

- 行格式：`${indent}| ${cells.join(' | ')} |`；
- 表头 = `cells[0]`；分隔行按 `grid.colAlign[c]` 生成：
  - `left` → `:---`，`center` → `:---:`，`right` → `---:`，其它 → `---`；
- 单元格转义：`text.replace(/(\\*)\|/g, (_, bs) => bs + bs + '\\|')`。
  - 该规则在 GFM 下是正确的：N 个反斜杠 + 管道 → 2N 个反斜杠 + `\|`（先转义反斜杠，再转义管道）。
  - 条件 5 保证不会出现现有 `splitRow` 解析不一致的输入。
- `raw`（HTML 来源的未编辑单元格）原样放入单元格：内联 HTML 在管道表格里仍然有效；条件 6 保证不会把标签里的管道转义坏。

### 2.2 `src/editor/writeback.ts`（改动）

```ts
export interface CommitOptions {
  /** 显式要求管道写回（工具栏「转 MD」）；网格不可管道化时放弃写入。 */
  forcePipe?: boolean;
}

export function commitGrid(
  view: EditorView,
  region: TableRegion,
  grid: TableGrid,
  opts: CommitOptions = {},
): boolean;
```

决策：

| 条件 | 结果 |
|---|---|
| `opts.forcePipe && canSerializePipe(grid)` | pipe |
| `opts.forcePipe && !canSerializePipe(grid)` | 放弃写入，返回 false |
| `region.tableKind === 'pipe' && canSerializePipe(grid)` | pipe |
| `region.tableKind === 'pipe' && !canSerializePipe(grid)` | HTML + 一次性提示（合并降级） |
| `region.tableKind === 'html'` | HTML（保持原存储） |

- `source` 校验、no-op 比较、单区间替换保持不变。
- 一次性提示文案更新为"合并单元格无法用管道语法表示，已改用 HTML"。

### 2.3 `src/widget/tableEditor.ts`（改动）

1. `foldPendingEdit()`：单元格文本改为
   ```ts
   const raw = (el.innerText || el.textContent || '').replace(/​/g, '');
   const text = raw.replace(/\s+/g, ' ').trim();
   ```
   折叠换行与连续空白，保证单行（R4）。
   - 注意：`innerText` 在可见元素上会按布局返回换行；单元格是可见的。若为空则退回 `textContent`。

2. 工具栏新增「转 MD」：
   - 仅当 `this.region.tableKind === 'html'` 时添加（pipe 表格自动保持 Markdown，无需按钮）；
   - 启用条件 `canSerializePipe(state.grid)`；禁用时 title 说明原因；
   - 点击：`foldPendingEdit()` → `currentRegion()` → `commitGrid(..., { forcePipe: true })`；
     - 成功：Notice「已转换为 Markdown 管道表格」；
     - 失败（不可表示 / source 不匹配）：Notice 说明原因，不改文件。
   - 位置：`拆分` 之后、`源码` 之前，加一个分隔符。

### 2.4 `src/model/exportMarkdown.ts`（新增，纯函数）

```ts
export interface MarkdownExport {
  text: string;
  converted: number;   // 实际转换的表格数
  skipped: number;     // 可识别但不可管道化的 HTML 表格数
}

export function exportMarkdown(source: string): MarkdownExport;
```

算法：

1. `source.replace(/\r\n/g, '\n')`，按 `\n` 拆行，建立每行的绝对起始偏移表。
2. 收集替换 `{ from, to, insert }`：
   - **正文 / 列表内**：`scanTableLines(lines)`；只处理 `tableKind === 'html'` 的块；
     `parseHtmlTable` → `canSerializePipe` ? `serializePipeTable(grid, block.indent)` : 跳过并 `skipped++`。
   - **引用块内**：`scanQuoteLines(lines)`；对每个引用取 `source` 片段，`planInnerTables(quoteSource, quote.indent)`；
     只处理 `plan.tableKind === 'html'` 的计划；可管道化则在该引用的绝对偏移
     `quoteFrom + plan.relFrom .. quoteFrom + plan.relTo` 处替换
     `serializePipeTable(plan.grid, plan.prefix)`；否则 `skipped++`。
   - `planInnerTables` 返回空数组时（无表格或整块不安全）不做任何处理。
3. 按 `from` 从大到小应用替换（避免偏移失效）。
4. 返回新文本与计数。围栏、front matter、callout 由扫描器自然排除。

> 导出不处理 callout（`scanQuoteLines` 明确跳过）与"表格紧贴引用文字、渲染器不识别"的情况；它们保持原样。

### 2.5 `src/main.ts`（改动）

```ts
this.addCommand({
  id: 'copy-as-markdown',
  name: '复制当前笔记为 Markdown（表格转为管道语法）',
  checkCallback: (checking) => { ...active MarkdownView... },
});
this.addCommand({
  id: 'export-as-markdown',
  name: '导出当前笔记为 Markdown 文件（表格转为管道语法）',
  checkCallback: (checking) => { ...active MarkdownView... },
});
```

- 取文本：`view.editor.getValue()`。
- 转换：`exportMarkdown(text)`。
- 复制：`navigator.clipboard.writeText(result.text)`；失败时退回到临时 `<textarea>` + `document.execCommand('copy')`。
- 文件：`new Blob([text], { type: 'text/markdown;charset=utf-8' })` + `<a download="${file.basename}.md">` + `click()`；用 `setTimeout` 回收 blob URL。
- Notice：`已复制 Markdown（转换 N 张表格，M 张保持 HTML）`。
- **不调用任何 vault 写接口**。

## 3. 数据流与契约

```
用户编辑单元格
  → foldPendingEdit（单行规范化）
  → currentRegion（引用内表格用 posAtDOM 重解析）
  → commitGrid（source 校验）
      → canSerializePipe ? serializePipeTable : serializeHtmlTable
  → 单区间 replace
```

- `region.indent` 对正文是行首空白，对引用内是 `>` 链 + 列表缩进；两种序列化器都逐行复现。
- 管道表格的每一行都以 `|` 开头/结尾（同 shape），扫描器 `sameShape` 与 `isDelimiterRow` 均能识别。
- 分隔行由 `colAlign` 生成，`parsePipeTable` 能原样读回。

## 4. 失败与降级

| 情形 | 处理 |
|---|---|
| 合并 / 跨行 | 写 HTML（管道无法表达），一次性提示 |
| 无表头（HTML 表格） | 保持 HTML；「转 MD」禁用 |
| 单元格含换行 | `foldPendingEdit` 折叠为空格；序列化器仍拒绝换行作为兜底 |
| 反斜杠 + 管道 | 不可管道化，退回 HTML |
| `raw` 含 `|` | 不可管道化，退回 HTML |
| `source` 校验失败 | 放弃写入 |
| 导出时表格不可解析 | 原样保留，计入 skipped（能识别为 HTML 表格时） |

## 5. 兼容与风险

- **既有 HTML 表格**：不会被自动批量改写；用户可逐表「转 MD」或用导出命令得到 Markdown 副本。
- **AC29–AC31 行为变更**：引用内 pipe 表格编辑后从 `> <table>` 变成 `> | … |`；断言同步更新。
- **AC14 引用内表格渲染**：`planInnerTables` 对 pipe 行同样工作，渲染升级不受影响。
- **格式规范化**：编辑后表格会被统一成 `| a | b |` 风格（含表头/分隔行补全），这是编辑一次的正常代价；表格外字节不变。
- **行尾**：导出统一为 `\n`（Obsidian 编辑器内部即 `\n`）。
- **性能**：序列化是 O(单元格数)；导出仅在命令触发时全文档扫描一次。

## 6. 回滚

- 阶段 1（序列化器 + 写回策略）可独立回滚：`commitGrid` 恢复无条件 `serializeHtmlTable`，其余不动。
- 导出命令与工具栏按钮互不依赖，可分别移除。
- 不涉及数据迁移；已写出的管道/HTML 都是合法 Markdown。
