# 实施计划：引用块内表格可编辑渲染

## 阶段 0：准备（只读）

1. 阅读 `.trellis/spec/frontend/codemirror-widgets.md`（widget 事件 / 写回 / 验收约束）与 `.trellis/spec/frontend/data-safety.md`（零写入）。
2. 确认既有基线：`npm test` 63/63、`node scripts/acceptance.mjs` 29/29。

## 阶段 1：抽出 `TableEditor`

1. 新增 `src/widget/tableEditor.ts`：
   - 从 `tableWidget.ts` 原样迁移 `Selection`、`EditingCell`、`WidgetState`、`ordered`、`contains`、`paintCell`、`selectionMap` / `rememberSelection`。
   - `TableEditor` 构造参数：`{ key, region, resolve?, applyIndent? }`。
     - `key`：选区记忆键（正文表格 = `region.from`；引用内表格 = 捕获时的绝对 `from`）。
     - `region`：渲染时捕获的 `TableRegion`。
     - `resolve`：写盘前重新取区域；返回 `null` 放弃写入。正文表格不传（等于固定 `region`）。
     - `applyIndent`：正文为 `true`（沿用 `applyBlockIndent`）；引用内为 `false`。
   - 每次 `commitGrid` / 工具栏结构操作 / "源码"按钮前调用 `resolve()`，拿到当前 `from/to` 后再写。
   - `element` 即 `.mdft-table` 根（工具栏 + `.mdft-table__body`）；自带 `ResizeObserver` 调 `view.requestMeasure()`。
2. `src/widget/tableWidget.ts` 改为薄壳：`toDOM` 构造 `TableEditor`（`key = region.from`，`applyIndent = true`）并返回 `editor.element`；`destroy` 调 `editor.destroy()`。
3. 验证：`npm run typecheck && npm test`，以及正文表格全部 AC 通过（先只跑 AC1–AC13 子集或全量）。

## 阶段 2：引用内表格扫描（纯函数）

1. 新增 `src/model/innerTable.ts`：
   ```ts
   export interface InnerTablePlan {
     relFrom: number; relTo: number;      // 相对引用块 region.from
     prefix: string;                      // 每行要复现的行首前缀（含 > 链与列表缩进）
     tableKind: TableKind;
     grid: TableGrid;
     source: string;                      // 该表格原始源码（含前缀）
   }
   export function planInnerTables(source: string, indent: string): InnerTablePlan[]
   ```
   - 按 `\n` 拆行；每行先去掉引用块自身的列表缩进（与 `stripIndent` 一致）。
   - 每行用 `/^[ \t]*(?:>[ \t]?)+/` 剥出 `>` 链，记录内容起点；`prefix = 原行.slice(0, 内容起点 + 内容首部空白)`。
   - 对内容行运行 `scanTableLines`，逐块 `parsePipeTable` / `parseHtmlTable`。
   - **安全性**：表格首行必须真的带 `>` 前缀（懒续行起头无法安全重写）。任一表格不满足或解析失败 → 整个引用块返回空（不升级）。
   - `relFrom/relTo` 由拆行累计偏移算出（`\n` 计入）。
2. 单元测试 `tests/innerTable.test.ts`：
   - `> | a | b |` → 1 个 plan，`prefix === '> '`，`relFrom/relTo` 精确。
   - `  > | a | b |`（列表内引用，indent `  `）→ `prefix === '  > '`。
   - `> > | a | b |`（嵌套引用）→ `prefix === '> > '`。
   - `> - item` + `>   | a | b |`（引用内列表项）→ `prefix === '>   '`。
   - 围栏代码块里的管道不识别。
   - 懒续行起头的表格 → 返回 `[]`。

## 阶段 3：引用块挂载内嵌编辑器

1. `src/widget/quoteWidget.ts`：
   - `MarkdownRenderer.render(...)` 成功后（且 `wrap.isConnected && !destroyed.has(wrap)`）调用 `upgradeInnerTables(view, wrap, body, this.region)`。
   - `body.querySelectorAll('table')` 取一次快照；与 `planInnerTables(region.source, region.indent)` 配对：
     - 数量不等 → 整个引用块不升级 + `console.warn`（R4）。
     - 每个 `<table>` 的行数 / 首行列宽（colSpan 之和）与 `grid` 不符 → 不升级（防错位）。
     - 通过则 `table.replaceWith(new TableEditor(...).element)`。
   - `resolve`：`view.posAtDOM(wrap, 0)` 得到当前 base，`from = base + plan.relFrom`、`to = base + plan.relTo`；越界或抛错返回 `null`。
   - `destroy`：销毁全部内嵌 `TableEditor`。
   - `isInteractive` 选择器加入 `.mdft-table`（单元格点击/双击不触发引用选字与进源码）。
   - `copy` 守卫：原生选区的锚点在任何内层 `contenteditable`（表格单元格）里时，不劫持复制。
2. `styles.css`：`.mdft-quote .mdft-table` 的边距归零、工具栏 hover 正常（如需）。

## 阶段 4：验收（AC29–AC33）

1. 夹具：在 `scripts/acceptance.mjs` 的临时验收笔记里加入引用块内 pipe 表格、列表内引用 + 表格、嵌套引用 + 表格（或在 AC29 里现写现测）。
2. `AC29`：真实鼠标点引用内表格单元格 → 输入 → Enter → 断言：
   - 文档中该表格变为 `<table>`，**每行以 `> ` 开头**；
   - 引用块整体仍是同一个 blockquote（外部 `> ` 行数/内容不变）；
   - 表格外的字节逐字节不变。
3. `AC30`：工具栏插入行 → 源码前缀正确、重新渲染后仍是可编辑表格；`Ctrl+Z` 恢复。
4. `AC31`：列表内引用（`  > `）与嵌套引用（`> > `）中的表格可编辑且前缀正确；列表归属不变。
5. `AC32`：AC26 的单击/拖选复制/双击进源码仍通过；在表格区域双击不进入引用源码。
6. `AC33`：全量 `node scripts/acceptance.mjs` 33/33。

## 验证命令

```bash
npm test                       # 期望 63 + 新增单测全绿
npm run typecheck
npm run build && ./scripts/deploy.sh
./scripts/restart-obsidian.sh  # 如需重启
node scripts/acceptance.mjs    # 期望 33/33
```

## 回滚点

- 阶段 1 后：正文表格全部 AC 绿才继续；否则回退 `tableWidget.ts`（Editor 抽取是纯重构）。
- 阶段 3 后：若内嵌编辑器在引用块里无法获得焦点/高度上报异常，先只保留"扫描 + 计数校验"（不替换 DOM），随后单独排查；写回路径不受影响。

## 风险清单

| 风险 | 缓解 |
|---|---|
| 引用内 `contenteditable` 岛屿无法聚焦（宿主拦截） | 先用真实 CDP 点击验证；必要时 `mousedown` 里显式 `preventDefault()` + `focus()` |
| 渲染表格数与扫描数错位 | 数量 + 行数/列宽双重校验，不通过就整块只读 |
| 偏移漂移后写错区间 | 写前 `posAtDOM` 重算 + `commitGrid` 的 `source` 校验 |
| 引用块拖拽选字吞掉表格点击 | `isInteractive` 加 `.mdft-table` |
| 单元格编辑后引用块高度变化 | `TableEditor` 自带 ResizeObserver；引用块原有 ResizeObserver 兜底 |

## 完成情况（实施期回填）

| 项 | 状态 | 证据 |
|---|---|---|
| 抽出共享 `TableEditor` | ✅ | `src/widget/tableEditor.ts`：正文与引用内表格共用同一套工具栏/选区/单元格编辑/写回；`tableWidget.ts` 只剩 CM6 外壳（`eq`/`ignoreEvent`/生命周期）。正文 AC1–AC13 全部通过 |
| 引用内表格定位 | ✅ | `src/model/innerTable.ts`：按 `\n` 拆行 → 去列表缩进 → 剥 `>` 链 → `scanTableLines` → 映射回相对偏移与逐行前缀；10 个单测覆盖顶层引用、列表内引用、嵌套引用、引用内列表项、HTML 表格、围栏排除、懒续行拒绝、多表格顺序 |
| 渲染后升级 | ✅ | `quoteWidget.ts` 的 `upgradeInnerTables`：`querySelectorAll('table')` 快照与扫描计划按顺序配对，数量或行数/列宽不符则整块保持只读；`TableEditor` 原地替换 `<table>` |
| 写回契约 | ✅ | 仍只走 `commitGrid`；`region.indent` = 行首前缀（`> ` / `  > ` / `> > ` / `>   `），`serializeHtmlTable` 逐行复现；偏移在每次写盘前用 `posAtDOM` 重解析，`source` 比对兜底 |
| 交互隔离 | ✅ | `isInteractive` 加入 `.mdft-table`；`copy`/`selectionchange` 放行内层 `contenteditable` 的真实选区；坐标选字跳过表格文本 |
| AC29 | ✅ | 真实点击单元格 → `Input.insertText` → Enter：`{quotes:1, inner:1, tds:2, staticTables:0}`，写回为 `> <table>` / `>   <tr>…` / `> </table>`，表格外字节不变 |
| AC30 | ✅ | 悬停后真实点击「↓行」：`beforeTrs=2 → midTrs=3`，每行带 `> `，重新渲染后仍是可编辑表格；Ctrl+Z 后 `undone=true` |
| AC31 | ✅ | 列表内引用写回 `  > <table>`，嵌套引用写回 `> > <table>`；第二次编辑时第二段引用的 DOM 已被复用（偏移漂移），仍写对区间；`structureIntact=true` |
| AC32 | ✅ | 单击/拖选/复制/双击文字全部保持原行为；双击表格单元格后引用仍是渲染态（`widgets:1, quoteLines:0`） |
| 文档 | ✅ | README 更新（引用内表格可编辑、空引用行规则、结构图、技术要点）；spec 增加"在引用块里嵌入可编辑表格"四条契约与 `MarkdownRenderer` 比 Live Preview 更严格的空行规则 |

**最终验收**：`node scripts/acceptance.mjs` → **34/34 通过**；`npm test` 73/73；`npm run typecheck` / `npm run build` 通过。

**过程记录**：
- 最初的夹具把表格紧跟在引用文字后面，`MarkdownRenderer` 把它渲染成普通段落（管道符原样显示）——阅读视图语义要求表头前有空行。这说明扫描器比渲染器宽松，正是"数量校验不通过就整块放弃"这条兜底逻辑的现实依据。
- 既有 AC14 原本断言"引用里不得出现我们的表格"，与本任务 R1 直接冲突；已改为断言"引用内表格就是可编辑表格"，比原断言更强。
- 套件编号里没有 AC28，AC33 的回归清单已按实际编号（AC1–AC27 + AC29–AC32）生成。
