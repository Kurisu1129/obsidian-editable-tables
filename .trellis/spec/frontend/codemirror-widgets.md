# CodeMirror 6 块级 Widget 集成契约

> 本项目的核心风险面。以下每一条都是**实测踩出来的**，不是理论推导。写任何与 Live Preview 编辑器交互的代码前必须读完。

---

## Scenario: 用块级 Widget 接管一段文档区域

### 1. Scope / Trigger

- **Trigger**：需要把某段 Markdown 源代码渲染成可交互的 DOM，同时保留文本为唯一真相。
- 涉及 CM6 `Decoration.replace({ widget, block: true })`、`StateField`、`WidgetType`。

### 2. Signatures

```ts
class MyWidget extends WidgetType {
  constructor(readonly region: Region) { super(); }
  eq(other: MyWidget): boolean;          // 决定 CM6 能否复用 DOM
  ignoreEvent(): boolean;                // 决定 CM6 是否处理 widget 内的事件
  toDOM(view: EditorView): HTMLElement;  // 唯一的渲染入口
}

const field = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update: (deco, tr) => …,
  provide: (f) => EditorView.decorations.from(f),
});
```

### 3. Contracts

| 成员 | 契约 |
|---|---|
| `eq` | **必须同时比较源码与全部文档偏移量**（`from` / `to`）。只比源码是错误的，见下方 Wrong vs Correct。 |
| `ignoreEvent` | 返回 `true` 表示 CM6 不处理 widget 内的事件。若 widget 自带编辑能力（contenteditable、按钮），必须返回 `true`，否则 CM6 的选区模型会与内部 DOM 打架。 |
| `toDOM` | 渲染出的根元素**必须**是 `display: block`。绝不用 `display: contents`。 |
| 高度 | 元素高度必须与其实际视觉高度一致，否则 CM6 的 heightmap 失准，点击会落到偏移若干行的位置。内容异步变化时用 `ResizeObserver` + `view.requestMeasure()`。 |
| `StateField` 缓存 | 缓存了偏移量的字段**只能**在 `tr.docChanged` 为真时重算；纯选区变更必须走快速路径，否则每次移光标都要重扫全文。 |

### 4. Validation & Error Matrix

| 条件 | 后果 |
|---|---|
| `eq` 只比源码，文档在 widget 上方被编辑 | CM6 复用旧 DOM，事件闭包持有过期偏移 → **替换错误区间，损坏用户文档** |
| 根元素 `display: contents` | 宿主高度 0×0 → 光标落点偏移数行 |
| 高度未准确报告 | 同上，且症状随机、难复现 |
| `ignoreEvent` 返回 `false` 而 widget 含 contenteditable | 点击被 CM6 抢走，编辑态无法进入 |
| 在同一区间再叠一个 `replace` 装饰 | 与宿主/其它插件的装饰冲突，取舍行为不受控。用 `Prec.highest` 明确表态 |

### 5. Good / Base / Bad Cases

- **Good**：`eq` 比较 `source + from + to`；根元素 `display:block`；宿主高度实测与下一行间距 0px。
- **Base**：`eq` 恒返回 `false`（永远重建）。正确但浪费，仅作为排障手段。
- **Bad**：`eq` 只比 `source`；根元素 `display:contents`；在 `update` 里无条件重建缓存。

### 6. Tests Required

| 断言点 | 方式 |
|---|---|
| 装饰稳定压过原生渲染器 | 三种时机（初次打开 / 外围编辑 / 切换文件回来）断言原生 `.cm-table-widget` 计数恒为 0 |
| **偏移平移后不损坏文档** | 在块**上方**插入内容，再触发一次 widget 内操作，断言块外内容逐字节不变 |
| 高度准确 | 用真实鼠标事件点击块下方若干行的目标行，断言落点行号与目标一致 |
| 光标移动开销 | 大文档下连续 dispatch，断言单次耗时在帧预算内 |

### 7. Wrong vs Correct

#### Wrong

```ts
// 只比较源码。文档在表格上方被编辑后，源码没变 → eq 为 true →
// CM6 复用旧 DOM → 旧事件闭包里的 from/to 已过期 → 替换错误区间。
eq(other: TableWidget): boolean {
  return other.region.source === this.region.source;
}
```

#### Correct

```ts
// 偏移量也必须相等，复用才是安全的。偏移变了就重建 DOM 与处理器。
eq(other: TableWidget): boolean {
  return (
    other.region.source === this.region.source &&
    other.region.from === this.region.from &&
    other.region.to === this.region.to
  );
}
```

---

> **Warning**：`Prec.highest` 是功能性代码，不是风格偏好。
> Obsidian 原生同样用自己的块级 widget 渲染顶层表格；不声明优先级就压不过它，
> widget 会被静默忽略，症状是"插件像没生效一样"。

> **Warning**：装饰的重算发生在 `view.dispatch` **期间**（同步）。
> 任何"写回后清理状态"的代码都会在新 widget 构造之后才执行，
> 导致新 widget 读到过期状态。清理必须放在 dispatch **之前**。

> **Warning（硬约束，不可绕过）**：Obsidian **强制**裁剪所有非可编辑的块级 widget：
>
> ```css
> .markdown-source-view.mod-cm6 .cm-content > [contenteditable="false"] {
>   contain: paint !important;
> }
> ```
>
> 后果：widget 内**任何定位到自身边界之外**的子元素（悬浮工具栏、下拉菜单、tooltip）
> 都会被裁掉，且 `elementFromPoint` 落到下层元素上 —— 表现为"元素明明在 DOM 里却看不见、点不到"。
>
> **不要试图覆盖它。** 宿主用了 `!important`，写自己的 `!important` 只是军备竞赛，
> 而这条规则是宿主的**刻意保证**（防止 widget 内容串到相邻行）。正确做法是
> **把控件放进 widget 自己的盒子里** —— Obsidian 自己的表格 widget 就是这么做的
> （它的行列拖拽手柄位于单元格内部，而非块外）。
>
> 同类症状的排查顺序：`contain` / `overflow` → `!important` → 最后才是 `z-index`。
> 本例中 `z-index` 完全无关，却最容易误导排查方向。用
> `[...document.styleSheets]` 找出真正命中的规则再动手，比逐个猜测快得多。

---

## Pattern：widget 内嵌输入与工具操作共存

**问题**：widget 里既有 `contenteditable` 单元格，又有工具栏按钮。按钮用
`mousedown` + `preventDefault()` 阻止失焦（否则点击会打断选区），
但这同时**阻止了 `blur`，也就阻止了"失焦即提交"**——用户刚敲的字会被静默丢弃。

**解法**：让 widget 持有一份**可变的"活"数据**（`state.grid`），并遵循两条规则：

1. 单元格输入只更新 `state.grid`，标记 `dirty`，**不立即 dispatch**。
2. 任何工具操作在 dispatch 之前，先 `foldPendingEdit(state)` 把未提交的编辑并入
   `state.grid`，由此**同一次 dispatch 同时落盘输入与结构变更**。

```ts
const apply = (fn: (g: TableGrid) => TableGrid): void => {
  this.foldPendingEdit(state);          // 先收编未提交的输入
  selectionMap(view).delete(region.from); // 再清过期选区（必须在 dispatch 前）
  if (commitGrid(view, this.region, fn(state.grid))) view.focus();
};
```

**注意**：`state.grid` 必须是 region 里那份 grid 的**副本**。
region 会被 StateField 缓存复用，直接改它会让未提交的文本泄漏进后续渲染。

---

## Pattern：宿主高度变化必须主动上报

**问题**：widget 的高度可能在**没有文档事务**的情况下变化 —— 例如用户在
`contenteditable` 单元格里打字导致换行。CM6 的 heightmap 无事务不重算，
于是编辑过程中点击表格下方内容会落到错行。

**解法**：在 widget 根节点挂 `ResizeObserver`，回调里调用 `view.requestMeasure()`；
并在 `WidgetType.destroy(dom)` 中 `disconnect()` 掉，避免泄漏。

```ts
toDOM(view) {
  const observer = new ResizeObserver(() => view.requestMeasure());
  observer.observe(wrap);
  observers.set(wrap, observer);   // 按 dom 存，供 destroy 取回
  …
}
destroy(dom) {
  observers.get(dom)?.disconnect();
  observers.delete(dom);
}
```
