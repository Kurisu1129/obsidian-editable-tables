# 技术设计：Live Preview 内的可编辑表格

> 需求与验收见 `prd.md`。CM6 接入细节见 `research/obsidian-live-preview-api.md`。

## 1. 架构与边界

标准 Obsidian 插件工程（TypeScript + esbuild），通过 `registerEditorExtension` 向 CodeMirror 6 注入扩展。**不新增视图、不替换编辑器**（D1）。

实际交付结构（与初稿的差异见 §7）：

```
src/
├── main.ts                    # 插件入口：注册扩展、R8 提示的设置持久化
├── editor/
│   ├── index.ts               # Prec.highest 装配
│   ├── region.ts              # TableRegion 类型（含文档偏移与缩进）
│   ├── field.ts               # regionField（区域扫描，仅文档变更时重算）
│   │                          #   + tableField（装饰，选区变更走快速路径）
│   └── writeback.ts           # 唯一的写盘点：新鲜度校验 + 单块区间替换 + R8 提示
├── model/                     # 纯函数，零 Obsidian / CM6 依赖，可离线单测
│   ├── types.ts               # Cell / TableGrid / TableBlock
│   ├── scan.ts                # 行 → 表格块（锚定分隔行；排除围栏、front matter）
│   ├── parsePipe.ts           # 管道表格 → TableGrid（列宽取所有行最大值）
│   ├── parseHtml.ts           # HTML 表格 → TableGrid（容忍未闭合标签）
│   ├── serializeHtml.ts       # TableGrid → HTML <table>（逐行带缩进前缀）
│   ├── grid.ts                # 增删行列、移动、对齐、合并拆分 + 不变式归一化
│   └── html.ts                # 实体编解码（含边界校验）、转义、去标签
└── widget/
    └── tableWidget.ts         # 渲染 + 浮动工具栏 + 选区 + 单元格编辑 + 高度上报
```

初稿里规划的 `settings.ts`（无设置项）、`model/roundtrip.ts`（往返校验改为测试断言）、
`editor/tableScanner.ts` 与 `editor/decorations.ts`（合并进 `field.ts`）、
`editor/heightSync.ts`（并入 widget 的 `ResizeObserver`）、
`widget/toolbar.ts` 与 `widget/cellEditor.ts`（都在 `tableWidget.ts` 内，规模不足以拆分）
均未单独成文件。

**边界（明确不做）**：

- 不接管表格以外的块类型（代码块、引用、callout）
- 不替换 Obsidian 的 markdown 解析器 —— 只用 CM6 语法树定位，**语法树找不到的嵌套场景由 `tableScanner` 的行级扫描兜底**（这正是 F4 的缺口所在）
- 不实现语义化 HTML 行内序列化（不挽回 D3 失去的行内格式）

## 2. 关键设计决策

### D-A 全场景接管（顶层 + 嵌套），装饰优先级 spike 为〔必经门禁〕

**v1 同时接管顶层表格与列表项下的嵌套表格**，覆盖用户日常点击的全部表格。

两个场景的性质**完全不同**，实测已确认（见 `research/spike-cdp-findings.md`）：

- **嵌套场景是空白区** —— Obsidian 原生 Live Preview **完全不渲染**嵌套表格（F14：`tableWidgets=0`，逐行即裸管道源码），且原生表格命令在其上返回 `false`、文档零变化。我们的 `Decoration.replace` **零冲突**。这是修复用户痛点的主战场。
- **顶层场景是替换区** —— 原生已渲染为 `cm-table-widget`（F15）且原生命令全部生效（F16）。接管它意味着**替换掉一个工作正常的原生实现**，属主动降级换统一，而非填补空白。

**〔必经门禁〕spike**：用 `Prec.highest` 包裹我方扩展，验证替换装饰能否**稳定压过**原生渲染器。判定标准为 **AC10**（三种时机均不回退）。

- spike 成功 → 按全场景实施
- spike 失败 → **D3 + D5 组合无法达成**，必须回到用户重新决策（现实选项为退回「顶层保持原生渲染」的混合形态）。**不得带病推进。**

> 装饰优先级是本方案唯一的未知数（asar 静态分析已排除，见下文），必须实测。

### 静态分析已排除的路径

对 `obsidian-1.13.7.asar` 的静态分析结果（不可作为结论，仅记录）：

- 全库零命中 `Prec.<name>` —— 但 CodeMirror 的导入绑定在打包时会被改名，**不能据此断定 Obsidian 未使用优先级**。
- 读到了原生表格 widget 的真实源码：`cls: "cm-embed-block cm-table-widget markdown-rendered"`，含 `placeCursorInCell` / `getNextCell` / `deselectCells` / `getSelectionBounds` 等方法。
- `cm-embed-block` 是 Obsidian 的通用块级嵌入类，同族还有 `cm-preview-code-block`（含 mermaid）、`math-block`、`cm-html-embed`、callout。**接管表格会插进这个统一体系，连带风险需警惕。**

### D-B v1 直接实现单元格内嵌编辑器（一刀到位，不分期）

用户明确选择不做分期：**v1 同时交付结构操作与单元格原地文字编辑**，接受由此引入的风险。

内嵌编辑器因此是 v1 的必交付项，F10 的难点 ①（变更集同步）与 ②（高度同步）**全部进入 v1 风险面**，不再是可推迟项。

### D-C 单元格编辑器：原定内嵌 CM6 EditorView → **实际改为 `contenteditable="plaintext-only"`**

**原定理由**：担心中文输入法在 contenteditable 与 CM6 管理 DOM 混用时出错，故计划内嵌 EditorView 以继承 IME / 撤销 / 选区模型。

**实施期实测推翻了该前提（F20）**：用 CDP 的 `Input.imeSetComposition` 模拟真实中文组合输入（拼音 `zhangsan` → 候选 `张三丰` → 提交），单元格全程无丢字，最终正确落盘。原因是 widget 内部 DOM 不受 CM6 的 selection 管理，浏览器的原生 IME 直接可用。

**改选 contenteditable 的收益**：省掉整条嵌套编辑器链路 —— 内嵌 `EditorView`、`iterChanges` 偏移重映射、共享 history、单元格内解析限制（F10 的难点 ① ③）全部不再需要。实测撤销仍正常（R9 / AC11），因为提交走的是主编辑器的 `view.dispatch`。

**代价与边界**：单元格按构造即为单行（Enter 提交、Escape 还原），不支持 MultiMarkdown 的多行单元格；这与序列化格式一致，属已知边界。

**保留的门禁**：AC6（光标不偏移）仍然通过，实测 widget 底部到下一行间距为 **0px**。

## 3. 数据流与契约

```
文档变更
  → tableScanner 扫描                    产出 TableRegion[]
  → tableField 缓存（按 doc 版本 + 源码 hash）
  → decorations：
       光标不在 region 内  → Decoration.replace({widget: TableWidget, block: true})
       光标进入 region     → 不产出装饰（源码自然还原）
  → TableWidget.toDOM  读 region.grid → 渲染 <table>
  → 用户操作工具条      → grid.ts 变更 → serializeHtml → view.dispatch 替换 region
  → 单元格输入        → iterChanges 偏移重映射 → 转发主 view（v1 必交付）
```

### 契约

```ts
interface TableRegion {
  from: number; to: number;
  indent: string;            // 嵌套上下文缩进，写回时必须原样保留
  kind: 'pipe' | 'html';     // 来源格式（用于 R8 的可见标识）
  grid: TableGrid;
  sourceHash: string;        // LRU 缓存键
}

interface TableGrid {
  cells: Cell[][];           // 逻辑网格
  colAlign: ('left'|'center'|'right')[];
}

interface Cell {
  text: string;
  rowSpan: number;           // 默认 1
  colSpan: number;           // 默认 1
  covered: boolean;          // 被上方/左方 span 覆盖的占位格
}
```

### 不变式

1. `parse(serialize(grid)) ≡ grid` —— 往返稳定
2. `serialize` 输出的 span **无重叠、无越界**
3. `serialize` 输出**逐字节保留 `region.indent`** 的缩进上下文

## 4. 兼容与迁移

- **读入**：管道表格与 HTML 表格都要能解析（存量笔记全是管道表格）
- **写出**：统一 HTML `<table>`（D3）
- **惰性迁移**：只有结构操作或单元格编辑触发写回该表格；**打开、滚动、切换文件均不写盘**（R7 / AC9）
- **不主动批量迁移**存量笔记的表格格式
- **可见标识**：HTML 存储的表格在工具条上标出来源格式，避免"静默降级"（R8）
- **不改写 callout 内的表格** —— v1 该场景交由 `nested-markdown-renderer` 处理

## 5. 权衡记录

| 选择 | 得到 | 付出 |
|---|---|---|
| 原地增强而非独立视图（D1） | Dataview、git diff、同步、其它插件全部照常 | 受 CM6 单列约束，高度同步难（F10 ②）；与原生渲染器有冲突面 |
| 统一 HTML 落盘（D3） | 源码模型统一；合并单元格跨平台可用 | **全部表格失去单元格内行内 markdown**（F7）；管道表格可移植性丧失 |
| 主动替换原生表格实现（D3 + D5 组合） | 全场景统一的 HTML 存储模型 | **放弃原生渲染器与整套 `editor:table-*` 命令**（F16）；实现质量必须**不劣于原生**，否则是净退化 |
| 嵌套优先（D-A） | v1 零装饰冲突，直击主要痛点 | 顶层表格体验在 v1.1 才达标 |
| 单元格编辑一刀到位（D-B） | 交付完整的「渲染态可编辑」，与用户原始诉求一致 | 高度同步与变更集同步的风险**全部压进 v1**；一旦失败则整个方案翻车 |

## 6. 风险与回滚

| 风险 | 缓解 |
|---|---|
| **块 widget 高度失准 → 光标偏移数行**（F10 ②）—— **v1 最高风险项** | AC6 为硬门禁：进入单元格编辑阶段前必须有可运行的回归测试；`display: block` + padding 而非 margin（规避 `display: contents` 的 0×0 坑） |
| **与原生渲染器争抢顶层表格装饰** —— **必经门禁** | D-A：spike 验证 `Prec.highest`，判定标准 **AC10**。失败则 D3 + D5 组合不可达，必须回到用户重新决策 |
| **替换原生实现后质量不如原生** | 原生会自动重排对齐（实测），我们的序列化与结构操作必须达到同等水准；把「对齐输出」纳入 AC4 |
| **缩进上下文被破坏** → 表格脱离列表 | 契约不变式 3；AC2 用 2 空格与 4 空格缩进各测一例 |
| **Obsidian 升级导致 CM6 内部 API 变化** | 只用 `registerEditorExtension` 与公开 CM6 包，不碰 Obsidian 私有 API |
| **大文档多表格卡顿** | 仅视口内构建 widget（`visibleRanges`）+ 源码 hash 的 LRU（AC8） |
| **误写盘修改用户笔记** | 惰性迁移；AC9 断言只读操作零写入；建议笔记库纳入 git |

**错误处理约定**：解析失败 → **不渲染、不写盘**，console 输出带 `[md-formatter]` 前缀的警告，并向用户提示一次（AC7）。

**回滚**：禁用插件即回滚全部渲染行为。落盘影响仅限被编辑过的表格，且每张表的改动是独立 diff，可逐张 `git checkout`。

## 7. 实施期修正记录

计划与实测的偏差，全部有运行时证据：

| 项 | 计划 | 实际 | 依据 |
|---|---|---|---|
| D-C 单元格编辑器 | 内嵌 CM6 EditorView | `contenteditable="plaintext-only"` | 真实中文 IME 组合实测无丢字（F20） |
| 表格列宽规则 | 按表头宽度解析 | 取所有行的最大列数 | 原生即如此；按表头截断会永久丢失数据（F18 / R10） |
| 表头对齐 | 序列化时略过 `align` | 表头同样输出 `align` | 否则阅读视图与编辑视图不一致（R5） |
| 装饰复用条件 | `eq` 只比源码 | `eq` 同时比 `from` / `to` | 仅比源码会让 CM6 复用旧 DOM 的过期闭包，替换错误区间损坏文档 |
| 选区清除时机 | 写回后清除 | **写回前**清除 | 装饰重算发生在 dispatch 期间，写回后清除会读到过期选区 |

### 独立复核（trellis-check）发现并已修复

复核在实现完成后独立跑了一轮，找出 5 条会真实损坏用户数据的问题。全部已修复并固化为测试：

| # | 问题 | 后果 | 修复 |
|---|---|---|---|
| 1 | `decodeEntities` 只校验 `Number.isFinite` | 笔记含 `&#x110000;` 时 `String.fromCodePoint` 抛 `RangeError`，穿出 `StateField`，**该笔记彻底不可编辑** | 增加码点上界与代理区校验（R13） |
| 2 | `isDelimiterRow` 不要求含管道符 | 裸 `---` 被当作分隔行 → **YAML front matter 被解析成表格**，编辑一次吃掉收尾的 `---`，整篇笔记变成未闭合 YAML | 要求分隔行含 `|`；并显式排除 front matter 区间（R11 / AC12） |
| 3 | `commitGrid` 注释声称校验偏移量，代码里没有 | 写盘处缺少最后一道闸 | 补上 `current !== region.source` 即拒绝 |
| 4 | 工具栏 `mousedown` + `preventDefault` 抑制了 blur | **正在输入、尚未提交的单元格内容被静默丢弃** | 引入 `foldPendingEdit`，结构操作与未提交输入在同一次 dispatch 落盘（R12 / AC13） |
| 5 | 续行判定只看"是否含 `\|`" | 紧跟表格的散文（如 ``Use `x | y` for a pipe.``）被并入表格并被改写成 `<td>` | 实测原生规则后按"管道形状须与表头一致"实现 |

另有 6 条集成/状态问题一并处理：`widgetSelection` 改为按 EditorView 分区的 WeakMap（原来裸偏移做键会**跨笔记串扰**，导致合并操作作用于用户从未选中的单元格）、补上缺失的 `ResizeObserver` 高度上报（AC6 回归风险）、把 `registerEditorExtension` 提到任何 `await` 之前、解析失败改为带 `[md-formatter]` 前缀的警告、Escape 还原内联标记而非纯文本、合并单元格在单一来源时保留 `raw`。

**验收可自动化**：`scripts/acceptance.mjs` 驱动真实 Obsidian 跑完 AC1–AC13，`npm test` 跑模型层单测（47 个用例）。已知会干扰测试的三处环境陷阱记录在 F21 与脚本注释中（插件不持久化启用、`registerEditorExtension` 只对新编辑器生效、`vault.modify` 与防抖自动保存竞争）。
