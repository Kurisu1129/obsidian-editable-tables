# 技术设计：引用块渲染与嵌套块缩进对齐

> 需求与验收见 `prd.md`，执行计划见 `implement.md`。
> 全部技术依据来自 `research/`，本文只做设计决策与契约，不重复证据。

## 1. 架构与边界

### 1.1 现状：一条**表格专用**的接管路径

上一个任务交付的链路是：

```
文档文本
  └─ model/scan.ts        行级扫描 → TableRegion[]     （锚定分隔行，排除 front matter / 代码围栏）
       └─ editor/field.ts
            ├─ regionField   StateField<TableRegion[]>  （仅 tr.docChanged 时重扫）
            └─ tableField    StateField<DecorationSet>  （纯选区移动走快速路径）
                 └─ Decoration.replace({ block: true, widget: TableWidget })
                      └─ widget/tableWidget.ts           （DOM、工具栏、选区、单元格编辑）
                           └─ editor/writeback.ts        （唯一写盘点）
```

`Prec.highest` 用于压过 Obsidian 顶层的原生 `cm-table-widget`。

### 1.2 本任务：从「表格专用」泛化为「块级容器」

新增两类 region，**共用同一套 field / 装饰 / 快速路径机制**：

| region 类型 | 来源 | 是否替换原生 | `Prec.highest` |
|---|---|---|---|
| `table` | 既有 | 是（压过 `cm-table-widget`） | **必需** |
| `quote` | 新增 | 否 —— 纯引用块本来就没有原生 widget（F29） | **不需要** |
| 代码块 | —— | **不接管**（D7/R22） | —— |

**关键洞察**：引用块与表格在「装饰优先级」上的处境完全不同。纯引用块没有任何原生 widget 去争这块区间（F29 的 asar 证据：`G` 恒为 −1，永不建 widget），所以**接管引用块不需要 `Prec.highest`**，也就没有 AC10 那类「优先级竞争是否稳定」的风险。这是本任务比上一个任务**风险更低**的地方。

### 1.3 边界

- **不做**：callout 接管（D6 后置）、代码块接管（D7/R22）、移动端。
- **不动**：`model/` 的表格解析与序列化、`writeback.ts` 的写盘逻辑（本任务只读渲染引用块，不新增写盘路径）。
- **必须保住**：AC1–AC13（R21）。

## 2. 契约

### 2.1 region 模型泛化

现状 `TableRegion` 与扫描器都写死了表格语义。**不新建平行的 `QuoteRegion` 体系**，而是把 `field.ts` 的 region 列表泛化为带 tag 的联合：

```ts
// src/editor/region.ts
export type RegionKind = 'table' | 'quote';

interface RegionBase {
  kind: RegionKind;
  from: number;        // 行首
  to: number;          // 末行行尾（必须行对齐 —— F33 的硬约束）
  indent: string;      // 源码缩进前缀，逐字节保留
  source: string;      // 区间原文，用于新鲜度门禁与 WidgetType.eq
}

export interface TableRegion extends RegionBase { kind: 'table'; grid: TableGrid; }
export interface QuoteRegion extends RegionBase { kind: 'quote'; lines: string[]; }

export type Region = TableRegion | QuoteRegion;
```

> ⚠️ **命名冲突（规划期复核时发现，实施前必须先解决）**：`kind` 这个名字**已经被占了**。
> 现状 `src/model/types.ts:35` 有 `TableKind = 'pipe' | 'html'`，`TableBlock.kind`（types.ts:43）
> 与 `TableRegion.kind`（region.ts:11）都用它，且 `writeback.ts:61` 依赖
> `region.kind === 'pipe'` 做分支。上面的 `RegionKind = 'table' | 'quote'` 直接撞车。
>
> **建议**：`kind` 让给判别联合（本文档通篇的 `region.kind` 读起来最自然，且窄化点最多），
> 把表格**风味**改名为 `tableKind`。改动面封闭在表格路径内，恰好就是阶段 1 要动的那几处：
> `types.ts` 定义、`scan.ts:124,153` 两处产出、`field.ts:53` 一处透传、
> `writeback.ts:61` 一处读取、`field.ts:12,24,44,46` 四处形参名。全部由 TS 编译期兜住。
>
> 反过来（`kind` 保留给风味、联合标签叫 `regionKind`）也能work，但 `region.regionKind` 拗口，
> 且违反本文档与 `prd.md` 里已写下的措辞。**二选一即可，别两个都叫 `kind`。**

**不变式**（保持既有契约，逐条不可破）：

1. `from` / `to` **行对齐** —— `block: true` 的 `Decoration.replace` 不能只覆盖一行的一部分（F33）。
2. `source` 是 `from..to` 的原文快照，用于 `WidgetType.eq` 与写回前的新鲜度门禁。
3. `indent` 逐字节保留。

> **陷阱**：既有代码里凡是 `region.grid` 的直接访问点，泛化后都要先窄化 `kind === 'table'`。
> TypeScript 的判别联合能兜住大部分，但 `tableWidget.ts` 里对 `region` 的闭包捕获要逐个过一遍。

### 2.2 引用块扫描（新增）

**扫描单位 = 一个连续引用块**（与 callout 同粒度，见 `blockquote-widget-editing.md`）。

判定「引用行」：

- 行首（去除缩进后）以 `>` 开头
- **lazy 续行**：引用块内不以 `>` 开头但语法上仍属该引用的行（F28 的 `HyperMD-quote-lazy`）
- 空 `>` 行属于区间；**区间内不得有非引用行**

**必须避开的既有雷区**（都是上一个任务踩过的）：

- 代码围栏内的 `> ` **不是**引用行 —— 扫描前必须先切出围栏区间（既有 `scan.ts` 已有该逻辑，复用）
- front matter 内的 `>` 同理
- **行对齐**：`to` 取最后一个引用行的行尾

**嵌套层级**：`> > x`、列表内的 `> x` 都要正确归入**同一个 region**（不做按层拆分），渲染时由 `MarkdownRenderer` 自行处理层级 —— 这是走整段渲染路径（而非自建 DOM）的直接收益。

### 2.3 引用块 widget

```
toDOM(view):
  wrap.mdft-quote            ← 定位上下文；自己设 padding-left（见 §2.4）
    ├─ host.mdft-quote__body ← MarkdownRenderer 的渲染目标
    └─ (渲染中显示占位，避免高度 0 → 光标偏移)

destroy(dom):
  component.unload()         ← 必须；否则嵌入的事件处理器泄漏（F31 坑 ②）
  observer.disconnect()
```

**渲染调用**：

```ts
const comp = new Component();
comp.load();
MarkdownRenderer.render(app, region.source, host, sourcePath, comp)
  .then(() => view.requestMeasure());
```

三条硬要求，逐条对应 F31 的坑：

1. **渲染前清空 `host`**（`host.replaceChildren()`）—— `render` 是**追加**语义，重复渲染会叠加。
2. **必须传 `Component` 并在 `destroy` 里 `unload()`** —— 否则 `console.error` 且泄漏。
3. **异步 → 必须先给占位高度**，渲染完成后 `view.requestMeasure()` —— 否则 CM6 heightmap 失准，光标落到偏移位置（`codemirror-widgets.md` 的既有契约）。

**传入 `region.source` 原文（带 `> ` 前缀）而不是剥掉前缀**：实测 `render('> |a|b|…')` 直接输出 `<blockquote><table>`（F32），由 Obsidian 自己处理引用条与层级；剥前缀再自己包 `<blockquote>` 是无收益的额外复杂度。

**已知的观感代价**：整段替换意味着长引用块在光标进出时**高度剧变**，可能有滚动跳动。原生 callout 有同样表现（`blockquote-widget-editing.md` 实测），可接受。

### 2.4 缩进：三种载体，各用各的手段

**根因**（`container-indent.md`）：Obsidian 给列表行按层级加 `padding-left: 23px; text-indent: -23px`，但**不给列表内的块级行加任何 padding**；而块级替换 widget 是 `.cm-content` 的**直接子节点**，`closest('.cm-line')` 返回 `null`，拿不到 `HyperMD-list-line-N`。

| 载体 | 手段 | 状态 |
|---|---|---|
| 表格 widget | widget 根节点设 `padding-left` | 既有缺陷，本任务修 |
| 引用块 widget | 同上 | 新增 |
| **原生代码块** | **CM6 行装饰**带 `margin-left: Npx !important` | **〔门禁〕D9 已通过**（spike 0.2） |

**原生代码块为什么必须是 `margin-left` + `!important`**（spike 0.2 实测，四种写法只有这一种合格）：

| 写法 | 文字 | 背景盒 | 判断 |
|---|---|---|---|
| `padding-left` | 移动 ✓ | **不动 ✗** | 不足 —— 背景盒仍压在项目符号左侧，从属关系没建立 |
| **`margin-left !important`** | 移动 ✓ | **移动 ✓** | **可行** —— 参与布局，右侧不溢出 |
| `position:relative;left` | 移动 ✓ | 移动 ✓ | 不可取 —— 盒子实际仍占原区间却绘制在 +40px 处，**右侧溢出**，会被 `contain: paint` 裁 |
| `transform:translateX` | 移动 ✓ | 移动 ✓ | 不可取 —— 同样溢出，且 `transform` 影响 `getBoundingClientRect`，会扰乱 CM6 坐标测量 |

**`!important` 的必要性**：inline `style="margin-left:40px"` 能写进元素，但 `getComputedStyle` 仍为 `0px` ——
宿主把 `margin: 0` 写在**级联层（`@layer`）里且带 `!important`**，层内 author `!important` 压过非 important 的 inline 样式。

> ⚠️ **与 `codemirror-widgets.md`「不要用 `!important` 对抗宿主」的告诫有张力，必须区别对待**：
> 那条针对 `contain: paint` —— 宿主的**刻意安全保证**，对抗它会让 bug 复现。
> 这里的 `margin` 只是宿主的**默认视觉样式**，不承载安全语义。
> 但仍应视为**范围极窄的有意例外**：**只允许出现在「列表内代码块行」这一处**，
> 且代码注释里必须写明理由与这条张力，避免后来者照抄成通用手法。

**退化行为可接受**：若 Obsidian 未来改掉这层 CSS，缩进**静默失效**（回到外凸），不报错、不损坏文档 —— 失败模式是「没效果」而非「坏掉」。

**缩进量的取法**（优先级从高到低，见 `research/container-indent.md` §3）：

1. **向前查找最近的 `.HyperMD-list-line-N` 兄弟节点，抄它的 computed `padding-left`** —— 自动跟随主题、字号、标记宽度（`- ` 得 24px，`1. ` 得 30px，是**逐行测量**的，不是固定值）。
2. 退化：按 `region.indent` 换算 `23 + 9*(level-1)`。**硬编码宿主度量，主题字号一变就错位**，仅作方案 1 失败时的兜底。

**不得**去改 `.HyperMD-list-line-nobullet` 的全局 CSS（R15 约束 / D7 否决）：
① 它算不出层级（F34：层级类只在 `begin` 行上）；
② 它有全局副作用（影响 Obsidian 内所有列表中的块级行）。

### 2.5 代价与不变式

- **零新增写盘路径**：引用块渲染是只读的（R18）。`writeback.ts` 仍是唯一写盘点。
- **每个 widget 必须实现 `eq`**（比较 `source` + `from` + `to`）与 `ignoreEvent`，并在 `destroy` 里断开 `ResizeObserver` 与 `Component` —— `codemirror-widgets.md` 契约，逐条适用。
- **快速路径必须保留**：`field.ts` 现有的「纯选区移动且前后都不碰任何 region → 复用原装饰集」是本任务性能的生命线 —— 引用块 region 区间大，不做快速路径会让每次光标移动都重建。
- **`contain: paint` 约束继续生效**：引用块 widget 内的悬浮/溢出元素会被裁（`codemirror-widgets.md` 硬约束）。

## 3. 数据流

```
文档变更 (tr.docChanged)
  └─ buildRegions(state)          ← 全量重扫：表格 region + 引用块 region
       └─ regionField              （仅 docChanged 时重算，既有契约）

选区移动 (tr.selection)
  └─ tableField.update
       ├─ 快速路径：前后都不碰任何 region → 复用原装饰集
       └─ buildDecorations
            ├─ 任一选区与 region 相交 → 跳过（显示源码）    ← AC18/AC22 的机制
            └─ 否则压入 Decoration.replace({block:true, widget})
                 ├─ TableWidget(region)   → editor/writeback.ts（唯一写盘）
                 └─ QuoteWidget(region)   → MarkdownRenderer（只读，零写盘）
```

**写回仅存在于表格路径**，且 `commitGrid` 的新鲜度门禁（`current !== region.source → 拒绝`）不变。

## 4. 兼容与迁移

- **无格式迁移**：本任务不改变任何落盘格式。引用块渲染是纯显示层。
- **既有 HTML `<table>` 与管道表格**：解析路径完全不动。
- **主题 / 字号变化**：缩进走「抄邻居 computed 值」而非硬编码，主题切换后由装饰重建自动跟上。
- **与其它插件共存**：不接管代码块（R22）意味着 Obsidian 原生代码块生态（各类高亮/折叠插件）不受影响。引用块是原生未占用的区间（F29），冲突面为空。

## 5. 权衡记录

| 选择 | 取了什么 | 代价 |
|---|---|---|
| 整段接管引用块（而非只接管内层表/码） | 一次覆盖表格+代码块+列表+标题（R14），且与原生 callout 同构 | 长引用块进出有高度剧变；渲染态不可内联编辑（编辑回源码态） |
| `MarkdownRenderer` 渲染 | 不重造 markdown 渲染器；内链/嵌入/高亮/数学全部白拿 | 异步 → 需占位与高度同步；`Component` 生命周期要管对 |
| **不接管**代码块 | 保住原生高亮/语言标签/折叠（R22），改动面最小 | 缩进只能靠行装饰补，且依赖 D9 门禁 |
| 代码块缩进走**行装饰**而非接管 | 拿到缩进控制权却不替换原生渲染 | 行装饰与宿主行装饰的相互作用未验证（D9） |
| 缩进抄邻居 computed 值 | 跟随主题/字号/标记宽度 | 要向前扫描 DOM 兄弟节点；扫描距离需设上限 |

## 6. 风险与回滚

| 风险 | 影响 | 缓解 / 回滚 |
|---|---|---|
| ~~D9：行装饰补缩进不可行~~ | —— | **已由 spike 0.2 排除**（4/4 时机稳定）。残余风险见下条 |
| `!important` 与宿主 CSS 的耦合 | Obsidian 改动内层 CSS → 缩进**静默失效** | 失败模式可接受（回到外凸，不报错不损坏）。AC17b 的三种时机断言会持续兜住 |
| 引用块渲染异步 → 高度失准 | **光标偏移数行**（R19/AC20） | 占位高度 + 渲染完成 `requestMeasure()`；`ResizeObserver` |
| `Component` 未 `unload` | 嵌入事件处理器泄漏（F31） | `destroy(dom)` 里必接；纳入 check 清单 |
| 重复渲染叠加 | 内容翻倍（F31 坑 ①） | 渲染前 `replaceChildren()` |
| 大区间装饰重建掉帧 | 长文档卡顿 | 保留 `field.ts` 快速路径；AC20 顺带观测 |
| region 泛化改坏表格路径 | **AC1–AC13 回归** | AC21 全量重跑；判别联合 + 逐点窄化 |

**回滚点**：阶段划分见 `implement.md`，每个阶段结束都是可回滚点。引用块路径与表格路径在 region 层共用、在 widget 层分离，**若要整体回退，只需让扫描器不产出 `quote` region**，表格能力不受影响。

## 7. 待实施期确认

1. ~~**D9 行装饰 spike**~~ —— **已通过**，结论见 `research/spike-0-findings.md`。缩进实现确定为 `margin-left: Npx !important` 的行装饰。
2. **引用块 region 的边界穷举** —— 嵌套引用（`> > `）、列表内引用、lazy 续行、区间内空行的组合未穷举，实施时以 fixture 固定。
3. **内链/嵌入点击** —— `MarkdownRenderer` 产物里的 `a.internal-link` 在 `ignoreEvent: true` 的 widget 内能否点击跳转，**未实测**。若不可用，需在 `ignoreEvent` 里放行链接点击；若放行后影响 CM6 选区，记为已知限制。
4. **缩进量的取法仍需落地验证** —— spike 用的是写死的 40px 以确认技术可行；真实实现要「抄最近 `.HyperMD-list-line-N` 兄弟节点的 computed `padding-left`」，
   这在**块是列表项第一个子块**（widget 前面没有可抄的列表行）等情形下的行为，见 `implement.md` 的 `fx-indent-blockonly.md`。

> spike 期间的踩坑（多 `.cm-editor` 实例、`Compartment` 默认值、探针代码热重载）见
> `research/spike-0-findings.md` 末尾 —— 写验收脚本时会再遇到。
