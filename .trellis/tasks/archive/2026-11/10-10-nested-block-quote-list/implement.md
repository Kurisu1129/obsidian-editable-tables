# 执行计划：引用块渲染与嵌套块缩进对齐

> 需求见 `prd.md`，技术设计见 `design.md`。阶段顺序依据 D7（引用块接管、代码块不接管）与 D9（行装饰门禁）。

## 阶段 0：Spike —— 两个未知数〔**必经门禁**〕 ✅ **已完成，两项均通过**

> **结论见 `research/spike-0-findings.md`。** 摘要：
> - **0.1 通过** —— 引用块在不加 `Prec.highest` 的情况下被接管；字面源码全部消失，
>   widget 内 `blockquote/h2/table/pre/ul` 全部渲染；三种时机稳定；**既有表格接管不受影响**。
> - **0.2 通过** —— 行装饰可行，但**只有 `margin-left: Npx !important` 这一种写法合格**：
>   `padding-left` 只推动文字、背景盒不动（不足）；`position`/`transform` 会让盒子右侧溢出被裁。
>   4/4 时机稳定无漂移；原生高亮/语言标签/折叠指示器未受损。
> - **副作用**：探针插件 `spike-vault/.obsidian/plugins/spike-probe/` 保留在 vault 里（已被 .gitignore 覆盖），
>   默认**停用**。确认既有基线未受影响：`node scripts/acceptance.mjs` → **13/13**。

本任务只有两个真正的未知数，动手写产品代码前必须先消灭。

### 0.1 引用块能否被自己的装饰接管（低风险，确认即可）

- [x] 在引用块区间上压一个 `Decoration.replace({ block: true, widget })`
- [x] 断言：widget 存在；**无需 `Prec.highest`**（纯引用块本就没有原生 widget，F29）
- [x] 覆盖三种时机：初次打开文件、编辑引用块外围文本后、切换文件再回来
- [x] 回归确认：**顶层表格接管未被连带影响**（AC10 的既有结论仍成立）
- [x] 记录结论与 Obsidian 版本号

### 0.2 行装饰能否给原生代码块补缩进（**D9，真正的门禁**）

- [x] 对列表项内原生代码块的行施加 `Decoration.line`，带内联 `style="padding-left: Npx"`
- [x] 断言代码块字形左边缘右移到「不早于父项正文」（F27 的 Range 手法）
- [x] **关键否定项**：观察是否与 Obsidian 自身的行装饰冲突 —— 背景盒错位、`--indent-unit` 相关规则被覆盖、行高变化
- [x] **稳定性**：三种时机下缩进不抖动；连续编辑后无累积漂移
- [x] **确认原生能力未受损**：语法高亮 `token`、语言标签 `.code-block-flair`、折叠指示器仍在

**结论分支**：

- ✅ 稳定生效 → 按 `design.md` §2.4 实施，代码块缩进纳入 AC17 / AC17b
- ❌ 冲突或抖动 → **回退为「代码块缩进不修」**，AC17 只覆盖本插件 widget，AC17b 标记为 not-applicable，其余阶段照常推进

> **未取得明确结论不得进入阶段 3。** 但阶段 1/2 不受此门禁阻塞（它们不依赖 D9）。

## 阶段 1：region 模型泛化〔纯重构，零行为变化〕

- [x] **先解决命名冲突**：`kind` 已被 `TableKind`（`'pipe'|'html'`）占用 —— 按 `design.md` §2.1 的注记把表格风味改名为 `tableKind`，把 `kind` 让给判别联合
- [x] `src/editor/region.ts` —— `Region` 判别联合（`table` / `quote`），保留 `region.indent` 逐字节语义
- [x] `src/editor/field.ts` —— region 列表泛化；所有 `region.grid` 访问点按 `kind` 窄化
- [x] `src/editor/writeback.ts` —— 入参窄化为 `TableRegion`（写盘路径只接受表格）
- [x] `src/widget/tableWidget.ts` —— 构造入参窄化

**验证**：`npm test` 全绿 + `node scripts/acceptance.mjs` **AC1–AC13 仍 13/13**。

> 这是本任务**唯一一次动既有成功路径**。此阶段结束时行为必须与阶段前**完全一致**，任何 AC 变化都是回归。**此阶段结束是一个强回滚点。**

## 阶段 2：引用块扫描与渲染

- [x] `src/model/scanQuote.ts` —— 行级扫描连续引用块；**复用** `scan.ts` 既有的围栏/front matter 排除逻辑，不得重复实现
- [x] 覆盖：`> ` 前缀、空 `>` 行、lazy 续行、`> > ` 嵌套、列表项内引用
- [x] `src/widget/quoteWidget.ts` —— `MarkdownRenderer.render` + `Component` 生命周期 + 占位高度 + `ResizeObserver`
- [x] `field.ts` 装配：引用块 region 走同一条 `buildDecorations` 路径

**验证**（AC14/AC15/AC16/AC18/AC22）：

- 引用块内的**表格、围栏代码块、缩进代码块、列表、标题**全部渲染
- 字面围栏行消失（AC15）
- 光标进入区间 → 整段还原源码，可直接编辑；离开 → 重新渲染，**磁盘内容不变**（AC22）
- 三种时机下接管稳定（AC18）

## 阶段 3：缩进对齐〔依赖阶段 0.2 门禁结论〕

- [x] 表格 widget 根节点：按 `design.md` §2.4 的方案取缩进量并设 `padding-left`
- [x] 引用块 widget 同上
- [x] **（仅当 0.2 通过）** 原生代码块行装饰补 padding

**验证**（AC17/AC17b/AC17c/AC20）：

- 表格 widget、引用块 widget、原生代码块三者字形左边缘**不早于**父项正文
- **回归对比基线**：表格 widget 修复前为 376 vs 409（外凸 33px），修复后不得再出现
- 代码块**零接管**：`.mdft-*` 不出现在代码块上，语法高亮与语言标签仍在（AC17c）
- 引用块前后插入文本行后点击落点与源码位置一致（AC20）

## 阶段 4：护栏与收尾

- [x] AC19：打开 / 滚动 / 切换文件期间笔记写入数为 **0** —— 引用块渲染是只读的，出现任何写入都是缺陷
- [x] AC21：**AC1–AC13 全量重跑**
- [x] 性能：长引用块 + 多引用块文档下的掉帧观测；确认 `field.ts` 快速路径仍在生效（装饰重建次数不随光标移动线性增长）
- [x] 内链/嵌入点击（`design.md` §7.3 的未决项）—— 实测并记录结论
- [x] `README.md` 更新：引用块能力、缩进策略、以及 D6（callout 后置）这个已知缺口
- [x] spec 更新：`codemirror-widgets.md`（`MarkdownRenderer` 在 widget 内的契约与三个坑）、`data-safety.md`（只读渲染不构成写盘路径）

## Fixture 清单

| 文件 | 覆盖 |
|---|---|
| `fx-quote-basic.md` | 引用块内表格 / 围栏代码块 / 缩进代码块 / 列表 / 标题（AC14–AC16） |
| `fx-quote-nested.md` | `> > ` 嵌套引用、列表项内引用、lazy 续行、区间内空行 |
| `fx-quote-edge.md` | 围栏内的 `> `（不是引用）、front matter 内的 `>`、紧邻两段引用（中间非引用行分隔） |
| `fx-indent-list.md` | 列表项内嵌：表格 / 原生代码块 / 引用块，各含一级与二级嵌套（AC17） |
| `fx-indent-blockonly.md` | **块是列表项的第一个子块**（父项正文与块不同行）—— 缩进取法的最难情形 |
| `fx-quote-readonly.md` | 引用块渲染期间的磁盘写入断言（AC19） |
| `fx-no-regression.md` | 上一任务的既有 fixture 全集（AC21） |

## 验证命令

```bash
npm test                     # 模型层单测
npm run typecheck
./scripts/restart-obsidian.sh
npm run build && ./scripts/deploy.sh
node scripts/acceptance.mjs  # 真实 Obsidian 上的 AC 套件
```

## 高风险文件与回滚点

| 文件 | 风险 |
|---|---|
| `editor/field.ts` | **既有成功路径**。region 泛化改坏 → AC1–AC13 回归（阶段 1 是唯一动它的地方，完毕即回滚点） |
| `widget/quoteWidget.ts` | `MarkdownRenderer` 异步 + `Component` 生命周期；高度失准 → **光标偏移数行**（R19） |
| `model/scanQuote.ts` | 引用块边界判定错误 → 装饰覆盖到非引用行，**用户在渲染态看不到自己的文本** |
| 行装饰缩进（阶段 3） | 与宿主行装饰冲突 → 背景盒错位（D9 门禁） |

**零写入不变式**：本任务**不新增任何写盘路径**。`writeback.ts` 仍是唯一写盘点；引用块渲染只读。

## 完成情况（实施期回填）

| 阶段 | 状态 | 证据 |
|---|---|---|
| 0 门禁 | ✅ | `research/spike-0-findings.md`：0.1 引用块可接管（无需 `Prec.highest`，不影响既有表格接管）；0.2 缩进仅 `margin-left: Npx !important` 合格，4/4 时机稳定。基线 `node scripts/acceptance.mjs` → 13/13 |
| 1 region 泛化 | ✅ | `TableBlock.kind` / `TableRegion.kind` 改名为 `tableKind`，`kind` 让给 `RegionKind`；`field.ts` 统一 `buildRegions`；`writeback.ts` 入参窄化为 `TableRegion`。重构后 AC1–AC13 未变（AC21 断言），`npm test` 58/58 |
| 2 引用块渲染 | ✅ | `scanQuote.ts` 9 个单测（连续 / 列表缩进 / 嵌套 / lazy / 标题不吸收 / 空行结束 / 围栏排除 / front matter 排除 / callout 跳过）；`QuoteWidget` 走 `MarkdownRenderer` + `Component` + `ResizeObserver`。AC14/15/16/18/22 通过 |
| 3 缩进对齐 | ✅ | 表格 widget 与引用块 widget 用 `applyBlockIndent` 量父项正文列位（实测 23.66px / 33.14px，父项 399.66 / 409.14）；原生代码块用 `codeIndent.ts` 行装饰补缩进（同值，顶层保持 0px）。AC17 / AC17b / AC17c / AC20 通过 |
| 4 护栏收尾 | ✅ | AC19 笔记写入 0；AC21 无回归；性能见下方"实施期补充结论"；README 与 spec 已更新 |

## 实施期补充结论

**性能**（542 行、30 个引用块 + 30 张表格，全部渲染在视口内）：

- 光标移动 dispatch：平均 **2.58ms**，p95 **5.1ms**，max **5.3ms** —— 在 16.6ms 帧预算内
- `field.ts` 快速路径仍在生效（`field.ts:139-143`：纯选区变更且不触及任何 region 时直接复用旧装饰集）；widget DOM 在视口未变时被 CM6 复用

**内链 / 嵌入**（design.md §7.3 的未决项）：**可用，无需特例**。

- `ignoreEvent: true` 只阻止 CM6 处理事件，宿主 `MarkdownRenderer` 绑在 `a.internal-link` 上的处理器仍生效
- 实测：引用块 widget 内点击 `[[probe-link-target]]`，活动叶正确切到目标笔记
- 嵌入 `![[...]]` 正常渲染为 `.internal-embed.markdown-embed.is-loaded`；外链 `a.external-link` 存在且 `pointer-events: auto`

**空列表项**（实施期发现的边界）：单独一行 `-` 的空列表项，Obsidian **不**给它 `HyperMD-list-line`，宿主本身就不按列表渲染。插件因此不为它下面的块加缩进 —— 与宿主表现一致，不是缺陷。已记入 README「已知边界」。

**最终验收**：`node scripts/acceptance.mjs` → **24/24 通过**（AC1–AC22，复核修复后连续两次全绿）；`npm test` → **63/63**；`npm run typecheck` / `npm run build` 通过。

## 代码复核与修复（实施后）

复核共提 15 条，逐条在真实编辑器里复现后：**2 条判为误报，其余确认为真问题并全部修复**。

| # | 问题 | 处理与证据 |
|---|---|---|
| 1 | lazy 续行被吞（误报） | 实测 `> - item` 的缩进续行被 Obsidian 标为 `HyperMD-quote-lazy`，**属于引用**。撤销了此前加的缩进条件，测试改为断言吸收，并注释说明原因 |
| 2 | `> %% hidden` 注释未隐藏（误报） | `MarkdownRenderer.render` 实测 `hidden: false`，无法复现 |
| 3 | 闭合围栏不比较长度 | ` ``` ` 会提前关闭 ` ```` ` 块，其后全部脱离 fence 掩码。改为同字符 + 长度 ≥ 开启者 + 无 info string（CommonMark） |
| 4 | front matter 里的 ``` 开启围栏 | 会掩掉全文的表格/引用。围栏扫描从 `frontMatterEnd + 1` 起 |
| 5 | 嵌套 / 首行为空的 callout 未跳过 | 改为扫描区间内第一条非空内容判断 `[!…]`，任意 `>` 深度 |
| 6 | 列表项内引用被切成两段 | 允许 lazy 续行不以 `>` 开头（Obsidian 行为），不再要求容器缩进 |
| 7 | 块位于子项之后时按子项缩进 | 新增 `contentColumn` 比较：只有正文列 ≤ 块缩进列的列表行才是祖先。新增 fixture `父项A / 子项A` 断言 201.65 ≈ 201.66 |
| 8 | 列表扫描无上界 | `MAX_LIST_SCAN = 512` 行，避免超长列表上的整页回溯 |
| 9 | 长代码块滚出开启行后缩进消失 | `marginCache` 按围栏起始行缓存像素值。滚动实测：`mid` 阶段 opener 已不可见，margin 仍为 23.66px |
| 10 | 引用块无法用鼠标进入源码 | `mousedown` 时 `posAtDOM` 现算位置（不存偏移），链接/嵌入/表单控件不抢 |
| 11 | `eq` 每次上方击键都重建并异步重渲染 | 引用块不持有偏移，`eq` 只比 `source + indent` |
| 12 | AC17c 选择器恒为 0（假断言） | widget 是整行替换、不可能是 `.HyperMD-codeblock` 的后代。改为：widget 总数 == 6、widget 矩形不与代码行矩形重叠、4 条代码行均有原生高亮、顶层代码块 `margin-left: 0px` |
| 13 | AC17 只有下界，"过度缩进"也能通过 | `aligned(a,b) = |a-b| ≤ 1px`，并新增子项之后的块用例 |
| 14 | AC6/AC20 点击落在 gutter，测试假失败 | 点击 x 改用目标行自身左边缘 +8px（实测 gutter 在 178px 之前，点击 84px 永远到不了正文） |
| 15 | AC17 探针在虚拟化下漏测半页 | 探针改为按视口滚动采集、按内容识别 widget、最后恢复滚动位置；连续两次 24/24 |

**未修复（已记入 README「已知边界」）**：

- 缩进代码块（四空格，非围栏）内以 `>` 开头的行会被识别为引用块 —— 只读渲染、不写盘；围栏代码块不受影响
- 源码模式仍会加载扩展并显示 widget（与表格既有行为一致）
- 主题 / 字号在 widget 挂载后变化时，已挂载 widget 的 `padding-left` 要等重新渲染才更新
- `regionField` 重建时会全文档扫描两次（表格 + 引用各一次），未做合并优化；当前 542 行/60 块的实测仍在帧预算内
