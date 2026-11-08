# 截图证据存档

原本落在仓库根的 `.shots/`（被 `.gitignore` 排除的本地临时产物，会随清理丢失）。
这里只留**被 `research/` 文档引用到的那几张**，让结论不依赖本机残留。

| 文件 | 拍的是什么 | 对应结论 |
|---|---|---|
| `probe4.png` | **问题现状（BEFORE）**：`probe4.md`，纯引用块内的管道表格 / 标题 / 列表**全部退化成字面源码** | 引用块渲染缺失的现场证据（`quote-block-rendering.md`） |
| `probe3.png` | 对照组：同一批块级内容放在**顶层**时正常渲染 | 证明退化成因是「容器」而非「块类型」（同上） |
| `spike02-none.png` | 门禁 0.2 基线：列表项内代码块，**背景盒恒为整行宽**、与项目符号左对齐 | `spike-0-findings.md` 的基线数字 376/392 |
| `spike02-pad.png` | 门禁 0.2 反例：`padding-left` —— **文字右移了，背景盒没动** | 为什么 `padding-left` 判为「不足」 |
| `spike02-margin.png` | 门禁 0.2 正例：`margin-left !important` —— 文字与**背景盒一起**右移 | 缩进实现最终选定这一种 |
| `impl-quote.png` | **实施完成后的 AFTER 态**：`fx-quote-basic.md`，引用块整段渲染（表格 / 标题 / 代码 / 列表） | 补上门禁 0.1 缺失的 AFTER 截图（产品代码而非探针） |
| `impl-indent.png` | 实施完成后的成品态：`fx-indent-list.md`，一级 / 二级列表项内的引用块、表格、代码块全部对齐父项正文 | AC17 的视觉取证 |

## 关于门禁 0.1 的 AFTER 截图

`spike-0-findings.md` 原本引用的 `spike01-quote-takeover.png` 当时没有落盘，只有计数与 DOM 断言。
该缺口现由 `impl-quote.png` 实质补上 —— 同一接管机制、同一种 fixture 形态，只是跑在产品代码上。
`probe4.png` 是同一现场的 **BEFORE** 态，两张合起来构成完整对照。
