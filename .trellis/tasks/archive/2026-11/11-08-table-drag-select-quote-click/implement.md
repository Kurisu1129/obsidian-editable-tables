# 实施计划：表格拖拽多选与引用块点击交互

## 阶段 1：表格拖拽多选

1. `src/widget/tableWidget.ts`
   - `WidgetState` 增加拖拽态：`drag: { r: number; c: number; moved: boolean } | null`。
   - 单元格 `mousedown`：非 Shift 时设锚点 + 单选；Shift 时沿用扩展逻辑。不 `preventDefault`（保留单元格内选字与单击进入编辑）。
   - 单元格 `mouseover`：若拖拽态存在且左键仍按下（`ev.buttons & 1`）且进入的是不同的格子 → 首次移动时清掉原生选区、给表格加拖拽类、`blur()` 掉 mousedown 聚焦的输入框；然后按锚点与当前格计算矩形选区并重绘。
   - 每次 `mousedown` 注册一次性 `window` `mouseup`，结束拖拽态并移除拖拽类；widget 重建时状态随 `state` 丢弃。
   - "合并"按钮：单选时 title 提示"拖拽框选或按住 Shift 单击可多选"；多选时给出选中格数。
2. `styles.css`
   - 拖拽期间 `user-select: none`（挂在表格根或 widget 的拖拽类上），避免拖拽顺手选中整页文字。

## 阶段 2：引用块点击交互

1. `src/widget/quoteWidget.ts`
   - 删除 `mousedown` 里"按下即进入源码"的逻辑，改为 `dblclick`：链接/嵌入/表单控件除外 → `preventDefault`、清除高亮，`view.posAtDOM(wrap, 0)` 放光标并 `focus()`。
   - 单击不拦截、不 `preventDefault`。
   - 拖拽选字：按坐标逐字符命中（`getBoundingClientRect`），构建 `Range`，用 `CSS.highlights`（`mdft-quote-selection`）绘制选区——不能设置 `window.getSelection()`，那会触发 Obsidian 的 selection 同步并重建 widget。
   - `document` 级 `copy`：有活动高亮且原生选区不在其中时，`preventDefault()` 并写 `text/plain`（跨块时在块边界补换行）。
   - 清除时机：新 mousedown、widget 外部 mousedown、Escape、`dblclick`、`destroy`。
   - `title = '拖拽选字复制，双击编辑源码'`。
2. `styles.css`
   - `::highlight(mdft-quote-selection) { background-color: var(--text-selection); }`
   - 拖拽期间 `.mdft-quote.is-selecting` 下 `user-select: none`。
3. `scripts/acceptance.mjs`
   - AC26 增加：拖拽后 `CSS.highlights` 有 `mdft-quote-selection`、`copy` 事件写出的文本包含引用内容且 widget 未还原。

## 阶段 3：验收脚本改用真实输入

1. AC4：改为真实 `Input.dispatchMouseEvent` 的 Shift+单击（横向两格），断言 5 个 `<td>`。
2. AC5：改为真实鼠标（纵向两格），保留 GitHub 白名单断言。
3. 新增 AC23：真实拖拽 2×2 → 4 格选中 → 合并 → 3 个 `<td>`、`colspan="2"` 与 `rowspan="2"`。
4. 新增 AC24：Shift+单击真实鼠标路径（与 AC4 合并，避免重复；AC4 本身即 AC24）。
5. 新增 AC25：单选时合并按钮 title 含"拖拽 / Shift"提示，多选时可用。
6. 新增 AC27：引用块内链单击跳转（若夹具不存在则补一个最小夹具）。

## 验证

```bash
npm test
npm run typecheck
npm run build && ./scripts/deploy.sh
node scripts/acceptance.mjs   # 期望 29/29（原 24 + 新 5）
```

## 回滚点

- 阶段 1 只改 `tableWidget.ts` + `styles.css`；若拖拽与"单击进入编辑"冲突，回退到 Shift-only 并只保留提示。
- 阶段 2 只改 `quoteWidget.ts`；单击选字/双击编辑若在真实 Obsidian 中不可行，回退为当前单击编辑并在 README 说明。

## 完成情况（实施期回填）

| 项 | 状态 | 证据 |
|---|---|---|
| 表格拖拽多选 | ✅ | `tableWidget.ts`：`WidgetState.drag` 锚点；非 Shift `mousedown` 仅记录按压，指针按住进入另一格才升级为框选（清选区、blur、`is-dragging`）；`window` 一次性 `mouseup` 收尾；指针回到锚点格时范围收缩回 1 格。真实鼠标 2×2 拖拽 → 4 格选中 → 合并得到 `colspan="2" rowspan="2"`、3 个 `<td>` |
| 手势可发现性 | ✅ | 单选时「合并」title = "拖拽框选，或按住 Shift 单击另一格，多选后可合并"；多选时显示 "合并选中的 R×C 区域" |
| 单击进入编辑不被破坏 | ✅ | 实测真实单击 `(1,0)` → `.mdft-cell-wrapper` 获得焦点 → 输入 `XY` → 失焦后落盘为 `<td>1XY</td>` |
| 引用块单击/双击 | ✅ | 删除 `mousedown` 拦截，改 `dblclick`；单击后 widget 仍在（quoteLines=0），双击后 widget 消失、selection 落在第 3 行 `> 引用第一行` |
| 引用块拖拽选字 | ✅ | 坐标命中 → `Range` → `CSS.highlights.set('mdft-quote-selection')`；AC26 断言高亮存在、`copy` 事件输出含 `引用第一行`、拖拽后 widget 未还原；清除时机覆盖新按下/外部点击/Escape/双击/销毁 |
| 虚拟化缩进自愈（复核期发现） | ✅ | 快速滚动会让 widget 在父项列表行未渲染时重建、丢失 `padding-left` 且永不恢复；`applyBlockIndent` 增加按缩进字符串的像素缓存，并新增 `widgetIndentRefresher`（`viewportChanged` 时重测全部 `data-mdft-indent` widget）。`codeIndent` 不再因"父项暂时不可见"清缓存，只有确定顶层才清。AC17/AC17b 从抖动变为稳定通过 |
| 验收探针稳定性 | ✅ | `openFile` 同时重置光标与滚动位置（只重置滚动会在"保存点跳转"后留下光标/滚动错位）；`collectIndent` 以"滚动元素不再移动"为终止条件，并在文末用 selection dispatch 强制渲染尾部 `cm-gap`；AC23 增加"拖出再拖回锚点 → 范围收缩为 1 格"的真实手势断言 |
| 链接行为 | ✅ | 引用块内 `[[probe-link-target]]` 真实单击后 `activeLeaf.file.path === 'probe-link-target.md'` |
| 验收改用真实输入 | ✅ | AC4/AC5 改为 `Input.dispatchMouseEvent`；新增 AC23（拖拽 2×2 + 拖回锚点收缩）、AC24（Shift 真实路径）、AC25（提示）、AC26（单击/拖选/双击 + copy）、AC27（内链） |

**最终验收**：`node scripts/acceptance.mjs` → **29/29 通过**（AC1–AC28，其中 AC24 与 AC4 共用同一次真实 Shift 手势，单独记录）；`npm test` 63/63；`npm run typecheck` / `npm run build` 通过。

**过程教训**：
- 合成 `dispatchEvent(new MouseEvent(...))` 只能验证算法，不能验证手势 —— 这正是本任务要补的验收盲区，已写入 spec。
- 引用块内 `contenteditable=false` island 既不能原生起选，也不能用 `window.getSelection()`（会被宿主同步回文档并重建 widget）；CSS Custom Highlight + `copy` 接管是可行路径，已验证。
- CM6 虚拟化下"父项不在 DOM"是常态而非异常：缩进测量失败必须回退缓存并在视口变化时重测，否则会永久错位。
