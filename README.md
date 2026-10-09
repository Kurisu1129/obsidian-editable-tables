# Editable Tables — Obsidian 插件

在 Obsidian 的 Live Preview 里把表格渲染成**可编辑网格**，并且能渲染 **Obsidian 原生拒绝渲染的、嵌套在列表项内的表格**。

## 它解决什么

| Obsidian 原生 | 装上本插件后 |
|---|---|
| 列表项内缩进的表格**完全不渲染**，显示裸管道源码，且 `editor:table-*` 命令返回 `false` | 正常渲染为可编辑表格，增删行列后缩进与列表结构原样保留 |
| 顶层表格可渲染，但增删行列/合并等能力只存在于**无 UI 的命令**里 | 鼠标悬停即出现工具栏，点一下就操作 |
| 无合并单元格 | 框选后合并，`colspan`/`rowspan` 落盘，**GitHub 也能正确渲染** |

## 用法

在 Live Preview 中把鼠标移到表格上，工具栏出现在表格上方：

```
↑行 ↓行 −行 │ ←列 →列 −列 │ 左 中 右 │ 合并 拆分 │ 源码
```

- **单元格编辑**：直接点进单元格打字。`Enter` 提交，`Escape` 还原，失焦自动提交。
- **合并**：点一个单元格，按住 `Shift` 点另一个选定一片区域，再点「合并」。
- **源码**：展开 Markdown 源码，回到原生编辑方式。
- 所有操作都可 `Ctrl+Z` 撤销、`Ctrl+Y` 重做。

## 安装（开发）

```bash
npm install
npm run build
./scripts/deploy.sh /path/to/your/vault    # 默认部署到 ./spike-vault
```

然后在 Obsidian 中启用 **Editable Tables**。

## 重要：存储格式与代价

表格一旦被你**实际编辑**，就会落盘为 HTML `<table>`：

```markdown
<table>
  <tr><th>姓名</th><th>年龄</th></tr>
  <tr><td colspan="2">张三 28</td></tr>
</table>
```

这是刻意的取舍，换来的是**合并单元格在 GitHub 上也能正确渲染**（MultiMarkdown 的 `^^` / `||` 私有语法在其他平台会显示成字面符号）。

**代价**：HTML 单元格内**不再解析 Markdown 行内格式** —— `**粗体**` 会原样显示。这是 HTML 的格式约束，不是本插件能绕过的。首次发生转换时插件会明确提示，不静默降级。

**只写你碰过的表格**：打开、滚动、切换文件都不会写入磁盘。合并单元格以外的普通操作也不会主动遍历全库改写。

## 已知边界

- **仅桌面端**（`isDesktopOnly: true`）
- 单元格按构造为单行，不支持 MultiMarkdown 的多行单元格
- **无法解析**的输入（例如未闭合的 `<table>`）拒绝渲染并原样保留源码，不改写文件
- 工具栏出现在表格**所在行的右端**（悬停 / 聚焦时显示）。表格较宽时它会盖住表头右上角一小块；面板窄于约 380px 时它会自动收缩换行成两排，按钮仍然全部可点 —— 见下方"宿主约束"
- 不接管 callout 内的表格（该场景可交给 `obsidian-nested-markdown-renderer`）

## 与宿主行为对齐

本插件**会写回文件**，所以"比 Obsidian 多识别一点"不是宽容，而是破坏 —— 被多识别的那段文本会在你第一次操作时被改写成表格标记。因此解析规则全部以**实测原生行为**为准：

| 规则 | 直觉 | 实测（Obsidian 原生） |
|---|---|---|
| 列宽 | 取表头列数，超出截断 | 取**所有行的最大列数**，短行补空 |
| 续行归属 | 只要含 `\|` 就算表格行 | 续行的**管道形状**必须与**表头一致** |

第二条的实际意义：表头写作 `| a | b |` 时，紧随其后的段落 `Use \`x | y\` for a pipe.` **不属于该表格**，不会被并入、更不会被改写。

**永不触碰的区域**：YAML front matter、代码围栏内的内容、未闭合的 `<table>`。

裸 `---` 在单格语法下是合法的分隔行 —— 不加限制就会把 front matter 解析成表格，编辑一次即吃掉收尾的 `---`，使整篇笔记变成未闭合的 YAML。这条已用测试固定。

## 宿主约束：工具栏为什么在表格内部

Obsidian 强制裁剪所有非可编辑的块级 widget：

```css
.markdown-source-view.mod-cm6 .cm-content > [contenteditable="false"] {
  contain: paint !important;
}
```

于是 widget 内任何定位到自身边界之外的元素都会被裁掉 —— 一个悬浮在表格上方的工具栏会**看不见也点不到**。这条规则带 `!important`，是宿主的刻意保证（防止 widget 内容串到相邻行），不该用 `!important` 去对抗。

所以工具栏落在 widget 自己的盒子里。这也是 Obsidian 自己的表格控件的做法 —— 它的行列拖拽手柄就在单元格内部，而非块外。

工具栏按**右边缘**对齐到 widget 盒的右端（也就是编辑行的右端），而不是表格的右边缘。对窄表格来说这样更好：工具栏停在表格右侧的空白里，一点都不遮挡。代价是表格很宽（占满整行）时它会压住表头右上角。

**面板窄于约 380px 时**（工具栏本身就这么宽）它会收缩并换行成两排，全部按钮仍可点。此前它会向左溢出到 widget 盒外被裁掉 —— 实测 12 个按钮只剩 3 个能点，且没有任何滚动条提示。两排虽然会盖住表格更多，但至少每个按钮都能用。

## 验证

```bash
npm test                     # 模型层单元测试（扫描 / 解析 / 序列化 / 网格操作），47 个用例
npm run typecheck
```

验收套件驱动**真实运行中的 Obsidian**，逐条断言 `prd.md` 的 AC1–AC13：

```bash
./scripts/restart-obsidian.sh    # 以调试端口启动 Obsidian（指向 spike-vault）
npm run build && ./scripts/deploy.sh
node scripts/acceptance.mjs
```

它通过 DevTools Protocol 打开文件、点击工具栏、派发真实鼠标点击与按键、模拟中文 IME 组合输入、统计磁盘写入次数 —— 全部针对真实编辑器，没有 mock。

其中几条专门盯着数据安全：

- **AC3** 编辑一个单元格后，表格之外的字节逐字节不变
- **AC9** 打开 / 滚动 / 切换文件期间，笔记文件写入数为 0
- **AC12** 含 front matter 的笔记里，只识别到正文的真表格，且 front matter 逐字节不变
- **AC13** 在单元格里打字后**不按回车**直接点工具栏，输入与结构操作同时落盘

## 结构

```
src/
├── model/          纯函数，零 Obsidian/CM6 依赖，可离线单测
│   ├── scan.ts         文档行 → 表格块（锚定在分隔行上，代码围栏内不误判）
│   ├── parsePipe.ts    GFM 管道表格 → TableGrid
│   ├── parseHtml.ts    HTML 表格 → TableGrid（容忍未闭合标签）
│   ├── serializeHtml.ts TableGrid → HTML <table>，逐行带缩进前缀
│   ├── grid.ts         增删行列、移动、对齐、合并拆分 + 不变式归一化
│   └── html.ts         实体/转义/去标签
├── editor/
│   ├── field.ts        两个 StateField：区域扫描（仅文档变更时重算）+ 装饰
│   ├── writeback.ts    唯一的写盘点：单块区间替换
│   └── index.ts        Prec.highest 装配
└── widget/tableWidget.ts   表格 DOM、工具栏、选区、单元格编辑
```

**视觉与原生逐像素对齐**：widget 根节点带 Obsidian 自己的 `markdown-rendered` 类，直接复用 `.markdown-rendered table|td|th` 这套由 `--table-*` 变量驱动的规则。实测表格宽度、行高、内边距、边框、`min-width` 与原生完全一致。

## 技术要点

- **`Prec.highest` 是必需的**，不是修饰：Obsidian 原生也用自己的块级 widget 渲染顶层表格，必须靠优先级压过它。
- **`WidgetType.eq` 必须同时比较偏移量与源码**：只比源码会让 CodeMirror 在文档上方发生改动后复用旧 DOM，而旧 DOM 的事件闭包仍持有过期偏移，导致替换错误区间、损坏文档。
- **块级 widget 高度必须准确报告**，否则光标会落到偏移若干行的位置。宿主用 `display: block`（绝不用 `display: contents`）。
