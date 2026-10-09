# 列表内嵌块渲染与可编辑表格

## Goal

为 Obsidian 增加「块级内容的可编辑渲染」能力，在 **md 文件仍是唯一真相** 的前提下：

- **表格可在 Live Preview 中可视化编辑** —— 单元格级编辑、增删行列、列对齐、合并/拆分；**顶层与列表项内嵌套的表格均覆盖**
- **列表项 / 子列表项内的表格能正确渲染** —— 解决 Obsidian 在嵌套上下文中不识别表格的缺口（顶层表格原生渲染正常，此处的目标是**接管**而非修复）
- 渲染细节更丰富、更美观，与 Obsidian 主题协调

用户价值：写结构化笔记时不再被脆弱的手写缩进和管道表格打断，编辑体验向 Typora / 我来(wolai) 靠拢。

**相对现有生态的差异点**：`obsidian-nested-markdown-renderer` 已解决「嵌套表格**只读渲染**」（光标进入即还原源码），但**不可编辑**。本任务的增量就是**可编辑**。

## Background

### 需求边界（已确认）

- 用户最初表述为「渲染 md 编辑器使其可编辑，类似飞书 / Typora」，但**已否决**「隐藏 markdown 语法」方向 —— 那是 Obsidian Live Preview + Minimal 主题 `Hide Markdown syntax` 已覆盖的能力。真实痛点是**块级模型**，不是语法可见性。
- 用户明确要求 **md 文件是唯一真相**。排除私有块树存储路线（Blockspace Workspace 的做法），所有编辑结果必须无损序列化回标准 md 文本。

### 已确认的技术事实

| # | 事实 | 来源 |
|---|---|---|
| F1 | CommonMark **允许**列表项内嵌任意块级内容，但要求缩进精确对齐到内容列（`- ` = 第 2 列，`1. ` = 第 3 列）。GitHub 用 2 空格、GitLab 用 4 空格。混用 tab/空格、嵌套前缺空行、从标记符而非内容列起算，都会**静默**解析失败 | remarkjs #1445、macmdviewer 缩进指南 |
| F2 | 嵌套表格不渲染的**最常见触发条件是表格前缺一个空行**；callout 内同理 | fix-table-pipe 技能文档 |
| F3 | Obsidian 阅读模式下嵌套有序列表超过 100 项会错位（第 100 项需两个 tab），删除前序项后缩进不自愈 | Obsidian 论坛 #38844 |
| F4 | **Obsidian 阅读视图能渲染列表项内的嵌套 GFM 表格，但 Live Preview 常常只显示管道源码** —— 这是 Live Preview 渲染器的已知缺口 | nested-markdown-renderer 项目说明 |
| F5 | GFM 管道表格本质扁平：单元格不能含块级内容，且**无合并单元格**。合并需私有扩展语法（MultiMarkdown `^^` / `\|\|`，已被 D2 否决）或原始 HTML | GFM 规范、Table Extended、Table Master |
| F6 | **GitHub 白名单明确放行 `<td>`/`<th>` 的 `colspan` / `rowspan`**，但剥离 `class` / `style` / `bgcolor` | GitHub 渲染 API 实测、Stack Overflow #23571724 |
| F7 | **Obsidian 不支持 HTML 标签内的 Markdown 格式** —— HTML 单元格内 `**粗体**` 会原样显示。这是 D3 代价的根因 | Obsidian 官方帮助 |
| F8 | WYSIWYG 表格**技术上可行**：必须做成 block widget，并在单元格内嵌套 EditorView —— 因为 CM6 要求内容单列排布（CM6 作者 marijn 结论） | discuss.codemirror.net/t/wysiwyg-table |
| F9 | 现成参考实现 `@markwhen/codemirror-tables`（源自 Joplin 富文本编辑器），单元格点击用嵌套 CM 编辑器 | npm |
| F10 | 主要技术难点**不在表格渲染**，而在：① 嵌套编辑器变更集同步（`iterChanges` 偏移重映射 + 共享 history）② block widget 高度同步（`ResizeObserver` + `view.requestMeasure()`，否则**光标偏移数行**）③ 单元格内解析限制 ④ 按源码 hash 的 LRU 性能缓存 | codemirror 讨论、grove 架构文档 |
| F11 | Obsidian **无法整体替换** CM6 编辑器。只能通过 editor extension 注入 Decoration（`Replace` / `Widget` / `Line` / `Mark`），由 `ViewPlugin`（视口内，性能更好）或 `StateField`（视口外 / 会改变视口内容）提供。入口 `(view.editor as any).cm as EditorView` | Obsidian 开发者文档 |
| F12 | 反例警戒：`obsidian-codemirror-options` 依赖 CM5 API，已随 CM6 迁移失效 | GitHub |
| F13 | 嵌套表格渲染的可行参考：`JoeChen2me/obsidian-nested-markdown-renderer` —— 在 Live Preview 中把列表项下的嵌套表格渲染为语义化 `<table>`，**从不改写笔记内容**，光标进入时还原源码。仅桌面端，Obsidian 1.12.7+ | GitHub |
| F14 | **实测确认**：列表项下缩进的表格在 Live Preview 中**完全不渲染**（`tableWidgets=0`、`tables=0`，逐行即裸管道源码），且原生表格命令返回 `false`、文档零变化 —— 渲染层与命令层**双重真空** | spike-cdp-findings.md |
| F15 | **实测确认**：顶层表格渲染为 `cm-embed-block cm-table-widget markdown-rendered` 块级 widget，内含真实 `<table>`；`isContentEditable=false`，无 input / contenteditable | spike-cdp-findings.md |
| F16 | **Obsidian 内置完整的表格结构命令**：`editor:table-row-before/-after/-up/-down/-copy/-delete`、`editor:table-col-before/-after/-left/-right/-copy/-delete`、`editor:table-col-align-left/-center/-right`。实测 `editor:table-row-after` 在**顶层**表格上生效并**自动重排对齐**；在**嵌套**表格上返回 `false` | spike-cdp-findings.md |
| F17 | 验证通道已建立：`--remote-debugging-port=9222` + CDP（node 内置 WebSocket，零依赖），可在真实 Obsidian 运行时读取 DOM、执行命令、断言文档内容。**验收可自动化** | spike-cdp-findings.md |
| F18 | **实测**：列数不一致的表格（表头 2 列 / 分隔 3 列 / 正文 3 列）**原生照常渲染**，且网格宽度取**所有行的最大列数**。按表头宽度解析会截断正文多出的单元格 —— 因为本插件会写回文件，那将是**永久性数据丢失** | scripts/acceptance.mjs AC7 |
| F19 | **实测**：`editor:undo` / `editor:redo` **不是注册命令**；撤销/重做绑定在键位（Windows 为 `Ctrl+Z` / `Ctrl+Y`，`Ctrl+Shift+Z` 是 macOS 绑定）。验证撤销必须派发真实按键事件 | probe-undo / t11 |
| F20 | **实测**：`contenteditable="plaintext-only"` 的单元格能正确处理中文 IME —— 拼音组合 `zhangsan` → 候选 `张三丰` → 提交，全程无丢字，最终正确落盘。**因此 D4 选内嵌 CM6 编辑器的原始理由（担心 contenteditable 的 IME）不成立** | ime.mjs |
| F21 | **实测**：`Plugin.registerEditorExtension` 只对**之后创建**的编辑器生效；`app.plugins.enablePlugin()` **不持久化**，重启后插件不会自动加载（需写入 `community-plugins.json` 或使用 `enablePluginAndSave`）。这两点会直接让自动化验收产生假阴性 | spikes 期间的多次误判 |

### 竞品现状

| 插件 | 路线 | 与本需求的关系 |
|---|---|---|
| nested-markdown-renderer | Live Preview 内嵌套表格**只读**渲染 | 路线一致，是 v1 的直接参考；差异点是**可编辑** |
| Butter Editor | md 原生 + 独立 WYSIWYG 视图，付费闭源 | 载体形态已否决（D1 选原地增强） |
| Table Master | 表格专项：可视化网格编辑器 + MultiMarkdown 合并单元格 | 表格能力参考；合并语法路线被 D2 否决 |
| Blockspace Workspace | JSON 块树存储 | 路线冲突，已排除 |
| Notioneer / notion-block | 斜杠命令 / 块菜单，只插入真 Markdown | 轻量壳层，非块渲染 |
| outliner | 列表行为增强 | 已知**不支持**「同层既有笔记又有子列表」及「子列表之后的笔记」 |

### 仓库现状

`F:\workplace\obsidian-md-formatter` 当前无任何源码，仅有 `AGENTS.md` 与 `.trellis/` 脚手架；无 `.codegraph/` 索引；无 git 历史。项目从零开始。

## Key Decisions

- **D1 载体形态 = 原地增强 Live Preview（受限接管）**
  用 editor extension 注入 `Replace` / `Widget` 装饰，**只接管表格这一块类型**（v1），其余渲染交给 Obsidian 原生逻辑；**不新增编辑视图**。
  理由：md 唯一真相、目标是编辑态体验、R6 生态不破坏，三条约束共同指向此路。替代方案（自建编辑视图）成本高一个数量级，且会削弱 Dataview 等插件注入编辑器的能力。

- **D2 合并单元格落盘为原始 HTML `<table>` + `colspan` / `rowspan`**
  **不采用** MultiMarkdown 私有语法（`^^` / `||`）—— 其 GitHub / VS Code / Typora 均不识别，会渲染成字面符号，直接违反 R5。GitHub 白名单放行 `colspan` / `rowspan`（F6）。

- **D3 所有表格统一落盘为 HTML `<table>`（非按需混合）**
  用户明确选择统一策略，接受其代价：**全部表格失去单元格内 markdown 行内格式**（F7）与管道表格的跨平台可移植性。
  **迁移策略 = 惰性**：仅在用户实际编辑某张表格时写回该表格，**绝不主动批量改写全库**（见 R7）。
  **实测补强的代价（F16）**：统一 HTML 意味着**放弃 Obsidian 原生表格渲染器与整套 `editor:table-*` 命令**。表格一旦落盘为 HTML，原生命令对其不再生效。因此我们的实现**必须不劣于原生**（原生会自动重排对齐）。

- **D4 v1 直接实现单元格内嵌编辑器（一刀到位，不分期）**
  用户明确选择不做分期：v1 同时交付**结构操作**（增删行列、列对齐、合并/拆分）与**单元格原地文字编辑**。
  取舍：不牺牲「渲染态可编辑」的完整诉求，但 F10 的难点 ①（变更集同步）与 ②（高度同步）**全部进入 v1 风险面**。
  因此 **AC6（光标不偏移）是本决策的硬门禁** —— 高度同步若不能稳定通过，方案必须回退，不得带病推进。
  单元格编辑器采用**内嵌 CM6 `EditorView`**，而非 `contenteditable`：中文输入法在 contenteditable 与 CM6 管理 DOM 混用时极易出错，内嵌 EditorView 自动继承 IME、撤销与选区模型。

- **D5 接管范围 = 顶层 + 嵌套全场景；装饰优先级 spike 为〔必经门禁〕**
  用户在「全场景统一 HTML」与「按需混合」之间**坚持前者**（B）。因此顶层表格必须由我们自建 widget 接管，这会**替换掉 Obsidian 目前工作正常的原生表格渲染器与命令**（F15 / F16）—— 属于**主动降级换统一**，而非填补空白。
  **强制前置**：spike 验证 `Prec.highest` 能否让替换装饰**稳定压过**原生渲染器。此 spike 从「可选回退」升级为**必经门禁**。
  **若 spike 失败**：D3 + D5 的组合无法达成，必须回到用户重新决策（现实选项为「接受顶层保持原生渲染的混合形态」，即退回 A 路线）。**不得带病推进。**

## Requirements

- **R1 单源无损**：所有渲染与编辑结果必须无损序列化回文本；不得引入私有格式或旁路存储。仅改动用户实际编辑的表格，其余内容字节不变。
- **R2 全场景渲染**：顶层表格与列表项 / 子列表项内的表格（管道或 HTML 源）在 Live Preview 中均正确渲染为可编辑网格；嵌套场景下缩进上下文被保留。
- **R3 表格可视化编辑**：单元格级点击编辑、增删行列、列对齐、合并/拆分单元格。
- **R4 渲染增强**：渲染细节丰富且与 Obsidian 主题协调。
- **R5 往返安全**：落盘结果在 Obsidian 阅读视图与 GitHub 下均正确呈现；不得产生破坏结构的畸形缩进。
- **R6 生态不破坏**：Dataview、git diff、同步、其它社区插件继续可用。
- **R7 无意外改写**：只写回用户实际编辑过的表格；打开、滚动、切换文件均不得修改磁盘内容。
- **R8 退化可见**：当一张表格因改用 HTML 而失去行内格式能力时，用户可感知（不静默）。
- **R9 可撤销**：所有写入操作（结构操作与单元格编辑）必须进入编辑器的撤销历史，`Ctrl+Z` 可回退、`Ctrl+Y` 可重做。
- **R10 不丢单元格**：解析列数不一致的表格时，网格宽度取所有行的最大列数（与原生一致），不得截断正文多出的单元格 —— 因为本插件会把结果写回文件。
- **R11 前置元数据不可侵犯**：YAML front matter 绝不被识别为表格，也绝不被改写。裸 `---` 是合法的单格分隔行，若不额外要求分隔行含 `|`，front matter 会被解析成表格，编辑一次就会吃掉收尾的 `---`，使整篇笔记变成未闭合的 YAML。
- **R12 编辑不丢失**：任何工具操作都不得丢弃正在输入、尚未提交的单元格内容。
- **R13 输入不致命**：任何畸形输入都不得让笔记变得不可编辑。解析链路上不得有可抛出的未捕获异常（如超范围的数字字符引用会让 `String.fromCodePoint` 抛 `RangeError`，穿出 `StateField` 后整个编辑器失效）。

## Acceptance Criteria

- [ ] **AC1 顶层表格渲染**：含顶层管道表格的 md，在 Live Preview 中光标移出表格后，`.cm-content` 内出现 `<table>` DOM，原源码行被 `Decoration.replace` 覆盖；光标进入后还原为源码。
- [ ] **AC2 嵌套表格渲染**：含「列表项下缩进表格」的 md（2 空格与 4 空格缩进各一例），Live Preview 中同样渲染为表格；列表层级与缩进上下文不被破坏。
- [ ] **AC3 单元格编辑**：双击单元格进入编辑，输入后失焦，md 文件被更新，且**该表格以外的内容字节完全不变**。
- [ ] **AC4 结构操作**：增删行列、列对齐、合并/拆分操作后，落盘为 `<table>`，`colspan` / `rowspan` 属性正确且自洽（无重叠、无越界）；输出的可读性与视觉对齐**不劣于 Obsidian 原生命令的自动重排对齐**（F16 —— 我们替换了原生实现，这是净退化的底线）。
- [ ] **AC5 跨平台呈现**：AC4 产出的 HTML **落在 GitHub 的白名单内** —— 标签仅 `table`/`tr`/`th`/`td`，属性仅 `colspan`/`rowspan`/`align`，不含 `class`/`style`/`bgcolor`（F6）。以对产出文本的断言代替人工目视。
- [ ] **AC6 光标不偏移**：在表格前后各插入文本行后，点击表格内任一单元格的落点与源码位置一致（F10 ② 的回归测试）。
- [ ] **AC7 畸形输入策略**：**无法解析**的输入（如未闭合的 `<table>`）拒绝渲染并原样回退，文件不被改写；**可解析**的畸形输入（列数不一致）按 F18 的原生规则渲染，且不丢失任何单元格（R10）。
- [ ] **AC8 性能预算**：单文档含 50 张表格时，滚动与输入无可感知卡顿；仅有视口内的表格被构建 widget。
- [ ] **AC9 无副作用**：仅打开、滚动、切换文件不产生任何磁盘写入（R7 的观测形式）。
- [ ] **AC10〔门禁〕装饰优先级**：在**顶层**表格上，我们的 widget 稳定接管原生渲染 —— 初次打开文件、编辑表格外围文本后、切换文件再回来三种时机下均不回退到原生 `cm-table-widget`。（D5 的前置条件，可通过 CDP 断言 `.cm-table-widget` 不存在、我方 widget 存在。）
- [ ] **AC11 可撤销**：结构操作与单元格编辑后，`Ctrl+Z` 回退到操作前内容，`Ctrl+Y` 重做恢复（F19）。
- [ ] **AC12 front matter 不被侵犯**：含 YAML front matter 的笔记中，front matter 区域**不渲染任何 widget**；对笔记中真正的表格做结构操作后，front matter 区间**逐字节不变**。
- [ ] **AC13 输入不丢失**：在单元格中输入文本、**不按 Enter**，直接点击工具栏按钮 —— 输入内容与结构操作必须**同时**落盘。

## Out of Scope

- **列表项内嵌非表格块**（代码块、引用）—— v1 只接管表格，其余块类型留待后续切片
- callout 内表格的修复（`nested-markdown-renderer` 已覆盖该场景）
- 私有块树存储、Notion Database、多视图表格（表格/看板/日历切换）
- 块级引用与分身同步（"一处更新处处更新"）
- 飞书式完整壳层交互（拖拽手柄、斜杠菜单、气泡工具条）
- 语义化 HTML 行内序列化（`**x**` → `<strong>`）—— 即不试图挽回 D3 失去的行内格式
- 主动批量迁移存量笔记的表格格式
- 移动端支持
- **复用 Obsidian 原生 `editor:table-*` 命令** —— D3 统一 HTML 后该路径不可用（F16），仅在光标进入源码时作为兜底残留
