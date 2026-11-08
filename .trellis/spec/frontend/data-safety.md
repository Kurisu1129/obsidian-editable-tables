# 数据安全：与用户笔记的唯一接触点

> 本插件的**全部**代码里，只有一处会写入用户文档：`src/editor/writeback.ts`。
> 任何新增的写盘路径都必须先读这份契约。

## Scenario: 把渲染后的模型写回 Markdown 文档

### 1. Scope / Trigger

- **Trigger**：任何需要修改文档内容的操作（结构操作、单元格编辑、格式化）。
- 违反以下任一条都会造成**用户数据丢失或损坏**。

### 2. Signatures

```ts
export function commitGrid(view: EditorView, region: TableRegion, grid: TableGrid): void
```

`TableRegion` 携带 `from` / `to` / `indent` / `tableKind` / `source`（`kind: 'table'` 是判别联合的 tag，`tableKind` 才是 `'pipe' | 'html'` 的表格风味）。`Region` 联合里还有只读的 `QuoteRegion`（`kind: 'quote'`），**它不是合法的 `commitGrid` 入参** —— 类型系统在这一层就挡住"给引用块写盘"。

### 3. Contracts

| 契约 | 说明 |
|---|---|
| **单块区间替换** | 只替换 `[from, to)` 这一个块，块外内容逐字节不变。 |
| **缩进逐字节保留** | 每行输出都加 `region.indent` 前缀。嵌套在列表项里的表格若丢掉缩进，就脱离了列表上下文。 |
| **幂等短路** | 序列化结果与当前源码相同时直接返回，不 dispatch —— 避免无谓地弄脏文档与撤销栈。 |
| **偏移量必须新鲜** | `region` 是 widget 构造时的快照。其有效性由 `WidgetType.eq` 保证（见 `codemirror-widgets.md`）。 |
| **读路径零写入** | 打开、滚动、切换文件**绝不**写盘。只有用户显式的编辑动作才写。 |
| **渲染与落盘解耦** | 渲染某张表**不**意味着要改写它。只有被编辑过的表格才落盘。 |
| **只读渲染不是写盘路径** | 引用块用 `MarkdownRenderer` 渲染（会加载嵌入、解析链接），但**渲染本身绝不触发任何写入**。不要为了"渲染得更完整"而加任何 fallback 写入或格式规整。 |
| **退化必须可见** | 写出会损失表达力的格式（如把管道表格转成 HTML）时，必须明确告知用户，不得静默降级。 |

### 4. Validation & Error Matrix

| 条件 | 应有行为 |
|---|---|
| 序列化结果 == 当前源码 | 直接返回，不 dispatch |
| 无法忠实地解析该块 | 不渲染、不写盘，原样保留源码 |
| 偏移量与文档不符 | 拒绝写入（由 `eq` 前置拦截；写盘处再加一道比对） |
| 表格含列表类缩进 | 输出每行带原缩进前缀 |
| 渲染引用块 / 光标进出 / 滚动 / 切换文件 | 零写入；渲染只产生 DOM |

### 5. Good / Base / Bad Cases

- **Good**：改一个单元格 → 只有那张表被替换，文档其余部分逐字节不变。
- **Base**：打开并滚动整个 vault → 零写入。
- **Bad**：为了"统一格式"在打开文件时遍历改写所有表格。

### 6. Tests Required

| 断言点 | 方式 |
|---|---|
| 块外内容不变 | 编辑表格中一个单元格，断言文档前缀与后缀**逐字节**相等 |
| 只读零写入 | 包装 `app.vault.adapter.write` / `writeBinary` 计数，跑打开/滚动/切换后断言笔记文件写入数为 0 |
| 引用块只读零写入 | 同上的包装手法，覆盖"含引用块 + 嵌套表格 + 内嵌代码块"的笔记，打开 / 滚动 / 切换一圈后笔记写入数为 0（AC19） |
| 缩进保留 | 嵌套表格做一次结构操作，断言所有表格行仍以原缩进开头、列表标记完好 |
| 不可解析即拒绝 | 未闭合的 `<table>`：断言 widget 数为 0 且文件内容不变 |
| 不丢单元格 | 列数不一致的表格：断言每一行的每个单元格文本都还在 |

### 7. Wrong vs Correct

#### Wrong

```ts
// 用捕获时的偏移直接替换，不校验它是否仍然指向这一段
view.dispatch({ changes: { from: region.from, to: region.to, insert } });
```

#### Correct

```ts
// 先比对当前文档在该区间的内容，确认 region 仍然有效且确有变化
const current = view.state.doc.sliceString(region.from, region.to);
if (current === insert) return;
view.dispatch({ changes: { from: region.from, to: region.to, insert } });
```

---

## 三条实测得出的硬约束

### 1. 解析链路绝不能抛异常

**症状**：笔记里只要出现一个超范围的数字字符引用（`&#x110000;`、`&#99999999;`），
该笔记的编辑器**彻底不可用**。

**原因**：`String.fromCodePoint` 对超出 Unicode 范围的值抛 `RangeError`。
异常会穿出 `StateField.update`，打断编辑器初始化。

**规则**：解析链路上所有"看起来不会失败"的 API 都要显式校验边界值。
只判 `Number.isFinite` 是**不够**的。

```ts
function fromCodePoint(code: number): string | null {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return null;
  if (code >= 0xd800 && code <= 0xdfff) return null;   // 孤立代理项
  return String.fromCodePoint(code);
}
```

### 2. 解析规则必须与宿主**实测对齐**，不能靠推导

本插件**会写回文件**，所以"比原生多识别一点"不是宽容，而是**破坏**——
被多识别的那段文本会在用户第一次操作时被改写成表格标记。

已实测对齐、且结论与直觉相反的两条规则：

| 规则 | 直觉 | 实测（Obsidian） |
|---|---|---|
| 列宽 | 取表头列数，超出部分截断 | 取**所有行的最大列数**，短行补空 |
| 续行归属 | 只要含 `\|` 就算表格行 | 续行的**管道形状**（是否以 `\|` 开头/结尾）必须与**表头一致** |

第二条的后果举例：表头写作 `\| a \| b \|`，紧随其后的段落 `Use \`x \| y\` for a pipe.`
**不属于该表格**；若误判为表格行，用户编辑一次就会把这段散文改成 `<td>`。

**另需单独排除的区域**（它们会被朴素规则误伤）：

- **YAML front matter**：裸 `---` 在单格语法下是合法的分隔行，
  不加限制会把 front matter 解析成表格，编辑一次就吃掉收尾的 `---`，
  使整篇笔记变成未闭合的 YAML。
- **代码围栏**内的内容。
- **未闭合的 HTML 表格**：拒绝渲染，原样保留。

### 3. 写盘前必须校验坐标仍然指向我们渲染的那段内容

`WidgetType.eq` 是**第一道**防线（见 `codemirror-widgets.md`），但写盘处需要**第二道**：

```ts
const current = view.state.doc.sliceString(region.from, region.to);
if (current !== region.source) return false;   // 坐标已失效，拒绝写入
```

只校验"新内容 == 旧内容"是**不够的** —— 那只证明这次是空操作，
不能证明这对坐标还指向当初渲染的那个块。注释声称有校验而代码里没有，
比没有注释更危险。

---

## 已知的表达力代价

把表格落盘为 HTML `<table>` 会带来两个**不可绕过**的后果（HTML 的格式约束）：

1. 单元格内**不再解析 Markdown 行内格式**。
2. 源码不再是管道表格。

换取的是 `colspan` / `rowspan` 在 GitHub 等平台的白名单支持。这个取舍必须对用户可见。
