# 设计：引用块双击定位到所点行

## 1. 关键事实（实测）

引用块的渲染链：

```
region.source（含缩进 + `>` 链）
  └─ stripIndent(region.source, region.indent)   // 只去掉列表缩进，保留 `>`
       └─ MarkdownRenderer.render(...)            // 渲染成一个外层 <blockquote>
            └─ .mdft-quote__body > blockquote
                 ├─ H1 / P / UL / PRE / BLOCKQUOTE / DIV.table-wrapper ...
```

- 外层 `<blockquote>` 是引用本身；它的**元素子节点**才是正文块，与源码块一一对应（实测：H1、P、UL、PRE、BLOCKQUOTE、P 对应 6 个源码块）。
- 列表的**直接 `<li>` 子节点**对应源码里同一层级的列表项；嵌套列表在 `<li>` 内部。
- `app.metadataCache` 对引用只给一个 `blockquote` section，粒度不够，不能用作行映射。

## 2. 纯函数层：`src/model/quoteLineMap.ts`

### 2.1 `projectQuoteLines(source, indent)`

把引用源码投影成"渲染器看到的内容行"：

```ts
export interface QuoteProjection {
  /** 去掉 `>` 链（与列表缩进）后的内容行。 */
  lines: string[];
  /** 每行被剥掉的前缀（缩进 + `>` 链 + 内容前导空白）。 */
  prefixes: string[];
  /** 每行在 source 中的起始偏移。 */
  starts: number[];
}
```

从 `innerTable.ts` 现有的投影循环中抽取，`planInnerTables` 改为复用它（行为不变，既有 10 个单测兜底）。

规则与现有实现一致：
- 先去掉 `indent`（列表缩进）；
- 匹配 `QUOTE_PREFIX_RE`（`^[ \t]*(?:>[ \t]?)+`）；
- 无 `>` 链的行是 lazy continuation，前缀只含 `indent`。

### 2.2 `scanQuoteBlocks(lines)`

把内容行切成顶层块，保守对齐 CommonMark：

```ts
export type QuoteBlockKind =
  | 'paragraph' | 'heading' | 'list' | 'code'
  | 'table' | 'blockquote' | 'hr' | 'html';

export interface QuoteBlock {
  startLine: number;        // 0-based，内容行下标
  endLine: number;
  kind: QuoteBlockKind;
  itemStarts: number[];     // 仅 list：顶层列表项起始行
}

export function scanQuoteBlocks(lines: string[]): QuoteBlock[]
```

规则：
- 空行分块；
- 围栏代码（``` / ~~~）整段一块，未闭合到结尾；
- ATX 标题一行一块；Setext 下划线并入前一段并标记 heading；
- 分割线（`***` / `---` / `___`，且不是 Setext）；
- 列表：记录每个顶层列表项的起始行；空行后若是列表项或缩进续行则仍属同一列表；未缩进的 lazy 行算续行；遇到缩进不足的新块起始则结束；
- 引用（`>`）整段一块，嵌套引用在渲染侧也是 `<blockquote>`；
- HTML 表格（`<table`）到 `</table>` 一块；其它 HTML 块到空行；
- 其余为段落；ATX / 围栏 / 引用 / HTML / 列表（bullet 或 `1.`）可打断段落。

### 2.3 `resolveQuoteLine(blocks, renderedCount, blockIndex, itemIndex, itemCount)`

```ts
/** 返回内容行下标；不可靠时返回 null（调用方回退到引用首行）。 */
export function resolveQuoteLine(
  blocks: QuoteBlock[],
  renderedCount: number,
  blockIndex: number,
  itemIndex?: number,
  itemCount?: number,
): number | null
```

- `renderedCount !== blocks.length` → `null`；
- `blockIndex` 越界 → `null`；
- 目标是 list 且 `itemIndex` 有效、`itemCount === itemStarts.length` → 返回 `itemStarts[itemIndex]`；
- 否则返回 `blocks[blockIndex].startLine`。

## 3. DOM 侧：`QuoteWidget` 的 dblclick

```
target = ev.target
root   = body.querySelector(':scope > blockquote')      // 找不到 → 回退
block  = target 向上爬到 root 的直接子元素               // 找不到 → 回退
index  = Array.from(root.children).indexOf(block)
li     = target.closest('li')，且其父 ul/ol 在 root 内
itemIndex = li 在父 ul/ol 的 LI 子节点中的序号
itemCount = 父 ul/ol 的 LI 子节点数
line   = resolveQuoteLine(blocks, root.children.length, index, itemIndex, itemCount)
```

`blocks` 由 `scanQuoteBlocks(projection.lines)` 得到；`projection` 基于 `region.source` / `region.indent`。

绝对位置：

```
base = view.posAtDOM(wrap, 0)                    // 每次事件实时解析，region 偏移可能已漂移
pos  = base + projection.starts[line] + projection.prefixes[line].length
view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
view.focus()
```

`line === null` 时保持现有行为：`view.posAtDOM(wrap, 0)`。

## 4. 边界与取舍

| 情况 | 行为 |
|---|---|
| 引用内含嵌入 / 数学块等渲染器额外结构 | 块数不一致 → 回退到引用首行（不猜） |
| 点击引用内已升级的表格 | `isInteractive` 已拦截，不进源码（不变） |
| 点击引用内**未升级**的静态表格 | 作为 table 块，落到表格首行 |
| 点击嵌套列表项 | 落到其顶层项的源码行（不递归配对，低保真但不会错块） |
| lazy continuation 段落 | 落到段落首行 |
| 引用块上方有编辑导致偏移漂移 | `posAtDOM` 实时解析 + `starts` 相对偏移，仍然正确 |
| 双击渲染态第一行 | 与现有行为相同（AC26 断言不变） |

## 5. 测试

- `tests/quoteLineMap.test.ts`：投影（`> `、`> > `、`  > `、lazy）、块扫描（段落/标题/Setext/列表/代码/嵌套引用/表格/分割线）、配对（列表项、数量不一致、越界）。
- 验收 AC40（列表第 3 项）、AC41（段落）、AC42（嵌入引用不崩溃且光标在区间内）；AC26/AC32 回归。

## 6. 风险

| 风险 | 缓解 |
|---|---|
| 自写块扫描与渲染器不一致 → 定位错块 | 块数不一致一律回退；列表项数不一致退到列表首行 |
| `region.source` 与 DOM 不同步 | 双击时实时 `posAtDOM`；source 只在 `eq` 相等时复用 |
| 双击坐标落在块间空白 | `target` 爬不到 root 子元素 → 回退 |
| 现有选字/复制交互回归 | 只改 dblclick 分支；AC26/AC32 覆盖 |
