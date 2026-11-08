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

> **推论：控件宽度必须能收缩。** 既然唯一可用空间就是 widget 盒本身，一个固定宽度的
> 横向工具栏在**窄面板**下必然向左溢出到盒外 —— 被 `contain: paint` 静默裁掉，没有滚动条、
> 没有报错，最左侧的按钮直接消失且点不到。实测面板缩到 520px 视口时，12 个按钮只剩 3 个可达。
>
> 对策是让控件在空间不足时**换行而不是溢出**（`flex-wrap: wrap` + `max-width: calc(100% - Npx)`），
> 代价是多占一行、遮挡更多。**"溢出被裁" 与 "换行遮挡" 之间没有第三个选项** —— 空间是硬约束。
>
> 验证方式：`Emulation.setDeviceMetricsOverride` 改视口宽度，再对每个按钮中心做
> `elementFromPoint` 命中判断（命中自己或自己的后代才算可达）。按钮"在 DOM 里、尺寸非零"
> 不等于"能点到"。

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

---

## Pattern：在 widget 内用 `MarkdownRenderer` 渲染整段 Markdown

**场景**：引用块（blockquote）的渲染内容与 Obsidian 自己的阅读视图同构，与其自己写一个 Markdown 渲染器，不如直接调用宿主的 `MarkdownRenderer`。

```ts
const info = view.state.field(editorInfoField, false);   // 需要 app 与当前文件路径
const comp = new Component();
comp.load();
MarkdownRenderer.render(info.app, markdown, body, info.file?.path ?? '', comp)
  .then(() => { if (wrap.isConnected) view.requestMeasure(); })
  .catch(() => { /* 降级为 <pre>，绝不能让异常穿出 toDOM */ });
```

**三个必须处理的坑**（每一个都可能静默损坏渲染结果）：

| 坑 | 后果 | 处理 |
|---|---|---|
| **追加语义** | 渲染到非空容器会**叠加**一层内容，重渲染一次就重复一遍 | 渲染前 `body.replaceChildren()` |
| **`Component` 生命周期** | 不传 `Component` 会 `console.error`，且嵌入内容的事件处理器不回收（泄漏） | 每个 widget 一个 `Component`，`toDOM` 里 `load()`，`destroy()` 里 `unload()` |
| **异步** | `render` 返回 Promise；渲染前后高度不同，heightmap 失准 → 光标落点偏移数行 | Promise 完成后再 `requestMeasure()`；同时挂 `ResizeObserver`（图片/嵌入在 Promise 之后仍会改变高度） |

**`ignoreEvent: true` 不等于"链接点不动"**：`ignoreEvent` 只决定 **CM6 是否处理** widget 内的事件，宿主 `MarkdownRenderer` 自己绑在 `a.internal-link` 上的点击处理器仍然生效。实测引用块 widget 内的 `[[笔记]]` 点击后正常跳转。所以不需要为了链接在 `ignoreEvent` 里写特例。

**只读渲染块不要用 `mousedown` 进入编辑**：`preventDefault` 之后浏览器无法开始文本选择，用户连复制一句话都做不到；而把 selection 放进 region 又会让整段 widget 立即还原为源码。正确的手势是**单击不拦截**（保留选字/复制），**`dblclick` 才 dispatch selection**；`title="双击编辑源码"` 负责可发现性。链接/嵌入/表单控件的 `dblclick` 仍要排除。

**`contenteditable=false` 的 island 里原生选字不可用，也不能用 `window.getSelection()` 代替**（实测）：Chromium 无法在 `.cm-content` 内这类 island 上起选（选区始终折叠，`caretRangeFromPoint` 也只会返回块边界的折叠 range）；而用程序给 `window.getSelection()` 设 Range 会被 Obsidian 的 selection 同步映射回文档位置，**拖拽途中 widget 就被重建/换节点**，最终常常直接还原成源码。可行方案是：widget 自己用逐字符 `getBoundingClientRect` 把坐标映射成 `(Text 节点, offset)`，用 `CSS.highlights.set(name, new Highlight(range))` 画选区（`::highlight(name)` 上色），并在 `document` 上接管 `copy` 事件写 `text/plain`。跨块选区要自己遍历克隆的 fragment 在块边界补换行（`Range.toString()` 会把两段拼成一行）。清空时机：新的 mousedown、外部 mousedown、Escape、`destroy`、`dblclick`。

**`destroy` 之后 Promise 可能才 resolve**：用一个 `WeakSet` 记录已销毁的根节点，回调里先检查 `isConnected`，避免对已脱离的 DOM 调 `requestMeasure`。

**渲染前剥掉列表缩进**：列表项内的引用块源码带 4 空格缩进，直接交给 `MarkdownRenderer` 会被解析成**代码块**。按 `region.indent` 去掉行首缩进后再渲染。

---

## Pattern：用行装饰给原生块补缩进（不接管 DOM）

**场景**：列表项内的围栏代码块由 Obsidian 原生渲染（高亮、语言标签、折叠都在），但它的 `.cm-line` 拿不到列表的 `padding-left`，左边缘贴到编辑区最左。既不想接管（会失去全部原生能力），又必须对齐。

**解法**：加一条 `Decoration.line({ attributes: { style } })`，只改视觉，不碰 DOM 结构与渲染归属。

```ts
Decoration.line({
  attributes: { style: `margin-left:${margin.toFixed(2)}px !important` },
})
```

**为什么必须是 `margin-left` + `!important`**（三种写法只有一种合格，均实测）：

| 写法 | 结果 |
|---|---|
| `padding-left: Npx` | 文字右移，**背景盒不动** —— 代码块的底色仍从最左边开始，视觉上不是"缩进" |
| `position: relative; left: Npx` / `transform: translateX(Npx)` | 盒子整体右移但**右边缘溢出**，被宿主的 `contain: paint !important` 裁掉 |
| `margin-left: Npx !important` | 整个行盒（文字 + 背景）一起右移，宽度自动收缩 —— **唯一合格** |

`!important` 不可省：Obsidian 把 `.cm-line` 的 `margin: 0` 声明在 **CSS 级联层**里并带 `!important`，不带 `!important` 的内联样式会输给它，`getComputedStyle` 仍是 `0px`（属性写进去了，但没生效）。

> **这是插件唯一允许对宿主使用 `!important` 的地方。**
> 作用域仅限"列表项内代码块的行装饰"。**绝不能**把它扩展到 `contain: paint` ——
> 那条规则是宿主对 widget 边界的刻意保证，对抗它只会让内容串到相邻行。

**测量必须幂等**：用**内容区左边缘**（`view.contentDOM.getBoundingClientRect().left`）作为基准，不要用行自身的矩形。行此刻可能已经带着上一次加的 `margin-left`，用它自己的矩形相减会得到 0，下一次重建就把装饰丢了 —— 症状是"打完字缩进消失，只有部分层级残留"。

**调度用 `queueMicrotask`，不用 `requestAnimationFrame`**：Chromium 在**非前台窗口**会节流甚至暂停 rAF。通过 CDP 驱动的 Obsidian 窗口经常不是前台窗口，rAF 方案会表现为"装饰永远不出现"。微任务在 dispatch 应用完 DOM 之后立即执行，是能测量几何的最早时机。

**不要在 IME 组合期间 dispatch**：`view.composing` 为真时额外的事务可能提前结束组合输入。挂一次性的 `compositionend` 监听，组合结束后再重算。

**重算必须自限**：插件自己 `dispatch({})` 会让 CM6 重新读取装饰。用"内容寻址"的 key（所有 `from:margin` 拼起来）比较，未变化就直接返回，否则会形成 dispatch → update → dispatch 的循环。

## 虚拟化下的缩进：测量失败 ≠ 真的没有缩进

CM6 只渲染视口。父项列表行完全可能不在 DOM 里，这时：

- `findOwningItemLine` 的 `previousElementSibling` 走链**找不到**父项（或跳过 `cm-gap` 后找到更远、错误的行）；
- 被测块自己却可能已经在 DOM 里（位于视口另一处）。

**不能把"找不到父项"当成"块是顶层的"。** 两种失败都真实出现过：

1. **widget 侧**（`applyBlockIndent`）：widget 在父项行未渲染时被重建 → `padding-left` 丢失 → 嵌套表格/引用块贴回最左，而且 widget 不会再次测量，**永久错位**。修法两层：
   - 按 `indent` 字符串缓存上次测到的像素列，找不到父项时回退到缓存；
   - 注册一个 `ViewPlugin`，在 `update.viewportChanged` 时对所有带 `data-mdft-indent` 的已挂载 widget 重新测一次（测量幂等，代价是一次 `getBoundingClientRect`）。
2. **原生代码行侧**（`codeIndent`）：打开围栏的行可见、但父项行在视口上方未渲染 → 旧代码 `cache.delete(startLine)` 把缓存清掉 → 缩进闪烁消失。修法：只有**确定是顶层**（`leadingWhitespace === ''`）才删除缓存；`findOwningItemLine` 返回 `null` 时保留缓存不动。

配套的验收经验：滚动测量必须从**光标与滚动位置都归零**的干净状态开始。若文件打开时光标停在文末（Obsidian 会恢复上次光标），探针"跳到文末再恢复"后会留下「光标在末尾、scrollTop 在顶部」的错位，CM6 的 viewport 与 DOM 布局不一致，会制造出上述所有假象。`openFile` 必须同时 `dispatch({ selection: { anchor: 0 } })` 与 `scrollTop = 0`。

## 依赖版本备注

`@codemirror/view` 6.38 的 `view.domAtPos(pos)` **只接受一个参数**（旧的 `bias` 第二参已从类型里移除）。需要精确映射时改用 `view.posAtDOM(line, 0)` 反向校验。

---

## 验收脚本（CDP）的两个必踩坑

**点击坐标必须落在 `.cm-content` 内**。`cm.dom.getBoundingClientRect().left` 是编辑器根的左边缘，包含了行号/折叠 gutter 和内容内边距（实测正文从 178px 开始，根在 44px）。在 `left + 40` 处 `dispatchMouseEvent` 命中的是 `.cm-scroller`，CM6 不处理，selection 停留在位置 0 —— 断言会报"点击落到第一行"，看起来像 widget 高度错误，实际是点击没进正文。用目标行自己的 `getBoundingClientRect().left + 8`。

**CM6 只渲染视口**。`querySelectorAll('.mdft-table')` 只返回当前渲染的 widget；长 fixture 单次测量必然漏掉半页。测量脚本应：

1. 按视口分步滚动，每步等待 ~250ms 让 CM6 完成 viewport 更新；
2. 按**内容**（`textContent.includes(...)`）识别 widget，不要按索引 —— 视口变化时索引会移位；
3. 每个值取"最后一次非空读数"：代码行的缩进装饰是在滚动后的微任务里才应用的，第一次读到可能是未装饰的值；
4. 测完恢复原 `scrollTop`。

**行装饰的断言要设上下界**。"不早于父项正文"只能排除贴左，无法排除缩进过头（例如按子项而非父项对齐）。用 `|a - b| <= 1px`，并专门放一个"块位于子项之后"的 fixture —— 那是唯一能暴露过度缩进的布局。

**不要写结构上恒为假的选择器**。widget 是整行 replace，`'.cm-line.HyperMD-codeblock .mdft-table'` 永远为 0，断言等于没写。要证明"没接管代码块"，应断言 widget 矩形与代码行矩形**不相交**，并断言代码行仍有原生高亮节点。

**交互验收禁止用合成事件**。`element.dispatchEvent(new MouseEvent('mousedown', {shiftKey:true}))` 绕过了命中测试、焦点转移与浏览器的真实事件链：合并功能的 AC4 曾用这种方式通过，但用户实际拖拽多选根本不工作。凡是验证"用户手势"的条目，一律用 `Input.dispatchMouseEvent`（拖拽要发 `mousePressed` → 多个 `mouseMoved` → `mouseReleased`；双击第二组用 `clickCount: 2`）。

**拖拽选择的实现要点**（表格 widget）：

- `mousedown` **不要** `preventDefault`：纯单击仍需要聚焦 `contenteditable` 才能"点进去打字"。
- 只有当指针在按键按住时进入**另一个单元格**，才把本次按压升级为框选：此时清空 `window.getSelection()`、`blur()` 掉刚聚焦的输入框、给表格加 `is-dragging`（`user-select: none`）。
- 拖拽结束监听 `window` 的 `mouseup`（`once + capture`），否则在表格外松手会留下粘滞的拖拽态。
- 每次 `mouseover` 重建工具栏前先比较选区是否变化，否则拖过一格会重建一次。
