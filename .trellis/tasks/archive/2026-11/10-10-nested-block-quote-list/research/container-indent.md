# 容器内嵌块的缩进成因（F25 的机理）

> 对应 PRD 的 R15 / AC17。全部结论为 2026-10-10 在真实 Obsidian 1.12.7 上实测。
> 测量手法：`document.createRange()` 取目标子串的字形盒 —— **不能用 `.cm-line` 的
> `getBoundingClientRect()`**，它恒为整行宽（376→980），量不出内容缩进。

## 1. 现象基线

编辑器内容区左边界 = **x 376**（`.cm-content` / `.cm-sizer` 同值）。

| 元素 | 字形/盒左边缘 | 相对 376 |
|---|---|---|
| 一级列表项正文（`- 项`） | 400 | +24 |
| 二级列表项正文（`  - 项`） | 409 | +33 |
| 有序列表项正文（`1. 项`） | 406 | +30 |
| 2 空格缩进的**代码块**内容 | **392** | **+16** |
| 4 空格缩进的代码块内容 | 409 | +33 |
| tab 缩进的代码块内容 | 408 | +32 |
| 2 空格缩进的**引用**内容 | 418 | +42 |
| 4 空格缩进的引用内容 | 429 | +53 |
| **本插件的表格 widget**（二级列表内） | **376** | **+0** |
| 代码块**背景盒** | 376 → 980 | 整行宽 |

两条结论：

- **代码块在 2 空格缩进下比父项正文还靠左 8px** —— 视觉上完全看不出从属关系。
- **本方 widget 外凸 33px** —— 这是当前已交付行为的真实缺陷，不是原生独有。AC17 必须涵盖它。

## 2. 机理：CSS 的 padding / text-indent

实测 computed style：

```css
/* 列表行：padding 撑开内容列，负 text-indent 把项目符号悬挂出去 */
.cm-line.HyperMD-list-line-1 { padding-left: 23px; text-indent: -23px; }

/* 嵌套在列表内的代码块行：没有任何缩进 padding */
.cm-line.HyperMD-codeblock.HyperMD-list-line-nobullet { padding-left: 0px; }
```

即：**Obsidian 给列表行按层级加 `padding-left`，但不给列表内的块级行加。**
块级行只带 `HyperMD-list-line-nobullet`，**拿不到 `HyperMD-list-line-N` 层级信息**（F27 的延伸）。

每级增量 = `--indent-unit: 0.5625em` ≈ 9px。实测一级 23px、二级 32–33px，吻合。
标记宽度是**逐行测量**的（`- ` 得 24px、`1. ` 得 30px），不是固定值 ——
所以想复刻对齐，必须读**实际计算值**，不能按字符数硬算。

## 3. 对本插件的直接影响

**块级替换 widget 不在 `.cm-line` 里。**

```
document.querySelector('.mdft-table').closest('.cm-line')  →  null
```

`Decoration.replace({ block: true })` 覆盖整行时，widget 成为 `.cm-content` 的**直接子节点**，
与各 `.cm-line` 平级，而不是被某个 line 包住。因此：

- widget **拿不到任何列表层级类**，不能靠 CSS 继承缩进
- widget 的左边缘 = 376，与 `.cm-content` 对齐 —— 这正是外凸 33px 的原因
- 想要对齐，只能由 widget **自己设置 `padding-left`**

### 可行的缩进来源（按可靠性排序）

1. **向前查找最近的 `.HyperMD-list-line-N` 兄弟节点，抄它的 computed `padding-left`。**
   最忠实 —— 自动跟随主题、字号、标记宽度、`--indent-unit` 的任意取值。
   风险：widget 前的若干行可能是空行或被其它 widget 占据，需要向前扫描；扫描距离需设上限。
2. **由 `region.indent`（源码缩进）自行换算**：`padding = 23 + 9*(level-1)`。
   简单、不依赖 DOM 结构，但把 Obsidian 的内部度量**硬编码**进来，
   主题字号一变就错位（`0.5625em` 是相对值，23px 是绝对测量值）。
3. **只对"父项正文"取一次快照**在 widget 构造时缓存；文档变化时随装饰重建刷新。

> 倾向方案 1，方案 2 作为退化路径。**这是设计阶段要定的**。

## 4. 边界与风险

- **顶层表格**：不在列表内时**不应**加缩进（否则会平白右移）。判据是 region 的缩进上下文，不是 widget 位置。
- **引用块内**：若引用块内嵌在列表项里，引用条本身要不要缩进？见 `quote-rendering` 相关研究。
- **改 `padding-left` 会改变 widget 宽度** → 触发 `ResizeObserver` → `requestMeasure()`。
  理论上收敛（padding 不随宽度变化），但要确认**不会自激振荡**（AC19/AC20 要盯）。
- **不要用 CSS 去改 `.HyperMD-list-line-nobullet` 的 padding**：那会影响 Obsidian 里**所有**列表内的块级行，
  属于全局副作用，且与本插件的 widget 无关（widget 根本不在 `.cm-line` 里）。
  这条只对**原生**代码块/引用块的外凸有效 —— 是否要做，取决于用户是否接受改宿主渲染。

## 5. 待定

- 原生代码块/引用块的外凸（2 空格 → -8px）**要不要修**？修就必须动宿主的 CSS，
  有全局副作用；不修则 AC17 只能覆盖本方 widget。
  —— 这是设计阶段需要向用户确认的一个取舍。
