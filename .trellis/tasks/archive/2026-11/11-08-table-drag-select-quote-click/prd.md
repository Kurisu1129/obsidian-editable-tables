# 表格拖拽多选与引用块点击交互

## Goal

修复两处"用户实际手势与实现不符"的交互问题：

1. 表格单元格当前只能用 Shift+单击多选，最自然的拖拽框选无效，界面也没有任何提示。
2. 引用块渲染态任意单击都会整段还原为 Markdown 源码，连选中文字复制都做不到。

## Background

- AC4/AC5 的验收脚本直接对 `<td>` 派发合成 `mousedown`（带 `shiftKey`），绕过了真实鼠标命中与事件链路。它证明了合并**算法**正确，但没有证明用户**手势**可用 —— 这是本任务要补的验收盲区。
- 真实 CDP 鼠标复测（2026-11-08）：Shift+单击可用；拖拽不可用（拖过两格后仍只有 1 格选中）；`.mdft-selected` 无任何可发现性提示。
- `QuoteWidget` 的 `mousedown` 处理器对任意左键单击（链接/嵌入/表单控件除外）都 `preventDefault` 并把光标放到块首行，selection 触及 region 后整段 widget 还原为源码（14 行）。

## Requirements

### R1 表格拖拽多选

- 在单元格上按下左键后，按住并移入其它单元格，选择范围随鼠标当前位置扩展（矩形范围，行列都支持）。
- 松开左键结束拖拽；`mouseup` 在表格外也应结束（监听 window/document）。
- 保留现有 Shift+单击扩展行为。
- 拖拽期间禁止浏览器原生文本选择（`preventDefault` / `user-select`），避免选中文字而不是单元格。
- 拖拽不应把单元格变成编辑态（不聚焦 contenteditable、不产生脏输入）。

### R2 可发现性

- 单选一格时，"合并"按钮的 tooltip 明确提示：拖拽框选或 Shift+单击可多选。
- 多选时按钮解禁的行为保持不变。

### R3 引用块点击交互（用户已选：单击选字，双击编辑）

- **单击**渲染态文字：不切回源码。在渲染文字上**拖拽**可选中文字并复制（`Ctrl/Cmd+C`）。
  - 实现约束（实测）：`contenteditable=false` 的 widget 内无法用原生鼠标起选；程序设置
    `window.getSelection()` 又会被 Obsidian 同步回文档并重建 widget。因此选区由 widget
    自绘（CSS Custom Highlight API），复制由 `copy` 事件提供。
- **双击**：光标进入引用块首行，selection 触及 region，整段还原为源码（沿用现有 AC22 的还原/重渲染机制）。
- 单击链接 / 嵌入 / 按钮 / 表单控件仍走各自的原生行为，不拦截。
- 引用块 widget 加 tooltip（如 `title="拖拽选字复制，双击编辑源码"`），让交互可发现。
- 点击左侧竖线等区域不额外做几何判断，统一按"单击选字、双击编辑"。
- 选区在以下时机清除：新的 mousedown、点击 widget 外部、Escape、`dblclick`、widget 销毁。

### R4 验收脚本改用真实输入

- AC4 / AC5 不再用 `element.dispatchEvent(new MouseEvent(...))`，改为 `Input.dispatchMouseEvent` 真实鼠标事件。
- AC4 至少覆盖两条路径：拖拽框选合并、Shift+单击合并。
- 新增引用块交互断言：单击后 widget 仍在（未还原）、双击后还原为源码且 selection 落在引用区间内。
- 新增/调整验收不得改变既有 AC 的语义；AC21 仍要求 AC1–AC13 全部通过。

## Acceptance Criteria

- [x] **AC23 拖拽多选**：真实鼠标从 `(1,0)` 按下、拖到 `(2,1)` 松开，`.mdft-selected` 恰好 4 格（2×2），"合并"按钮可用；拖拽途中离开锚点再回到锚点，范围收缩回 1 格；随后合并生成 `<td colspan="2">`，`td` 总数自洽。
- [x] **AC24 Shift 多选（真实鼠标）**：真实鼠标点 `(1,0)`、Shift 点 `(1,1)`，2 格选中、合并可用；合并结果与 AC4 既有断言一致。
- [x] **AC25 多选提示**：单选一格时"合并"按钮的 title/aria-label 含多选操作说明（拖拽或 Shift）；多选时按钮可点。
- [x] **AC26 引用块单击/拖选/双击**：真实鼠标单击引用块文字 → `.mdft-quote` widget 仍存在、无 `HyperMD-quote` 源码行；拖拽 → `CSS.highlights` 出现 `mdft-quote-selection`，模拟 `copy` 事件拿到的纯文本包含引用内容，widget 仍未被还原；双击 → widget 消失、源码行出现、selection 落在引用区间内。
- [x] **AC27 点击链接不触发编辑**：引用块内的 `[[内链]]` 单击仍跳转，不还原为源码（复用既有链接夹具）。
- [x] **AC28 无回归**：AC1–AC22 全部仍然通过（验收套件 24/24 + 新增条目）。

## Constraints

- 零写入不变式不变：交互改动不得新增写盘路径；单击/双击/拖拽不修改文档，只有合并等结构操作才写回。
- 不引入新的依赖。
- 引用块仍为只读渲染，不做行内富文本编辑。
- 表格拖拽必须与现有"点击单元格进入编辑"共存：拖拽（移动超过阈值）不聚焦输入框，纯单击仍进入编辑。

## Out of Scope

- callout 内的表格/引用（D6）。
- 引用块的逐行内联编辑。
- 表格区域的 Ctrl/Cmd 非连续多选。
