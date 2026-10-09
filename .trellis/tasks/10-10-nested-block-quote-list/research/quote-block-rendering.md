# Research: 引用块内块级内容的渲染决策点（Q1 + Q5）

- **Query**: Obsidian 到底在哪里决定「纯引用块内不渲染块级内容」？引用块 vs callout 的 DOM 与机制差异；callout 内的表格由谁渲染。
- **Scope**: internal（真实 Obsidian 1.13.7 运行时 + `obsidian.asar` 反查）
- **Date**: 2026-10-10
- **环境**: Obsidian 1.13.7（`Platform.version` = `1.13.7`，build `1.12.7`），vault = `spike-vault`，Live Preview（`editorLivePreviewField == true`）。

## 结论优先

1. **Live Preview 用「逐行 prop + 一个装饰构造器」决定渲染**，不是 CSS 开关。Obsidian 的 markdown 语法模式（StreamLanguage）给每行打一组 `line-HyperMD-* / hmd-*` prop；一个 `StateField`（在 `editMode.livePreviewPlugin` 数组里）遍历语法树、读这些 prop、按 prop 造块级 widget 装饰。
2. **纯引用块永远拿不到块级 widget**。引用行只带 `HyperMD-quote`（及其 `-1/-2` 层级、`-lazy`），**不带** `HyperMD-codeblock-*` / `HyperMD-table-row` / `HyperMD-header` / `HyperMD-list-line-*`。没有这些 prop，装饰构造器就不会为围栏代码块 / 表格 / 标题 / 列表造 widget → 全部退化为「带引用条的纯文本」。
3. **callout 是唯一例外**。当某行 prop 同时含 `HyperMD-callout` **且** `HyperMD-quote-1` 时，装饰构造器才把该处标记为块级区间的起点，最终整段替换成一个 `cm-embed-block cm-callout` 块级 widget。
4. **没有设置 / CSS 类能打开「引用块渲染块内容」**。决定权在语法模式的 prop 产出，不在样式层。
5. **callout 内容由 Obsidian 自己的 widget 渲染**（`cm-callout`，内部 `div.markdown-rendered` + MarkdownRenderer），其中的表格是 Obsidian 内建表格（普通 `<table>`，不可编辑），**不是**本插件的 widget。且 callout 渲染时其正文**没有对应的 `.cm-line`**（被 widget 整段替换），所以 CM6 装饰无法伸进 callout 正文 —— 这是「塞不进本插件表格」的硬卡点。

---

## 证据 1：纯引用块 vs callout 的 DOM

方法：`node tools/cdp.mjs -f ../spikes/research-probes/dom3.js`（打开 `probe4.md`，遍历 `.cm-content > .cm-line`），截图 `../spikes/shots/probe4.png`。

`probe4.md` 内容：

```md
## 引用里的表格
> | a | b |
> | --- | --- |
> | 1 | 2 |

## 引用里的标题
> ## 引用内标题

## 引用里的列表
> - x
> - y

## callout 里的表格
> [!note] 标题
> | a | b |
> | --- | --- |
> | 1 | 2 |
```

实测 DOM：

| 源 | DOM |
|---|---|
| 引用里的表格 3 行 | `.cm-line HyperMD-quote HyperMD-quote-1` ×3，子节点只有 `span.cm-formatting.cm-formatting-quote` + `span.cm-quote.cm-quote-1`。**表格没被识别**。 |
| `> ## 引用内标题` | `.cm-line HyperMD-quote HyperMD-quote-1`（**无** `HyperMD-header`）。 |
| `> - x / > - y` | `.cm-line HyperMD-quote HyperMD-quote-1`（**无** `HyperMD-list-line`）。 |
| callout 整段（5 行） | **无对应 `.cm-line`**；`.cm-content` 的直接子节点里出现 `div.cm-embed-block.cm-callout`（`contenteditable="false"`），内部：`div.markdown-rendered.show-indentation-guide > div.callout[data-callout=note] > div.callout-title + div.callout-content > table`。 |

callout 内表格的祖先链（`dom3.js` 输出）：

```
table
  div.callout-content
  div.callout
  div.markdown-rendered.show-indentation-guide
  div.cm-embed-block.cm-callout
  div.cm-content.cm-lineWrapping   ← widget 是 .cm-content 的直接子节点
```

即：**块级 widget 不与 `.cm-line` 同级嵌套，而是取代整段行、成为 `.cm-content` 的直接子节点**（本插件表格 widget 也一样，见 `container-indent.md`）。

对照组（`probe3.md`，`node tools/cdp.mjs -f ../spikes/research-probes/p3.js`，截图 `../spikes/shots/probe3.png`）：

| 源 | 行 class |
|---|---|
| A `> ` 引用里围栏代码块 `> ```js` | `HyperMD-quote HyperMD-quote-1`（**无** `HyperMD-codeblock`）→ 截图里显示裸 ` ```js ` |
| B 列表项里围栏代码块（无引用） | `HyperMD-codeblock HyperMD-codeblock-begin ... HyperMD-list-line-nobullet` → 截图里**渲染为代码框 + `JavaScript` flair** |
| C 列表项 + 引用 + 围栏代码块 | `HyperMD-quote HyperMD-quote-1` → 裸源码 |
| D 顶层裸围栏 | `HyperMD-codeblock ...` → 渲染 |

结论强化：**列表内会渲染围栏代码块，引用块内不会**；差异来自「是否为引用行」，与列表无关。

## 证据 2：装饰构造器源码（`obsidian.asar`）

方法：`node ../spikes/research-probes/asarall.cjs "D:/obsidian/resources/obsidian.asar" '<needle>' <before> <after>`（该文件 ≈22.6 MB，单行压缩；对大窗口用 `grep -a -o` 会超时，必须切片）。

装饰构造器是一个 `f.iterate({ enter(t){ ... } })` 的语法树遍历。关键片段（原文，压缩名）：

```js
var ie = i.prop(Zd);                       // 该行的 line-prop 集合
if (ie) {
  var re, oe = ie.split(" ");
  if ((re = new Set(oe)).has("HyperMD-callout") && re.has("HyperMD-quote-1")
        && (Z(r), G = r, K = a),            // ← 只有 callout 才把 G 设为区间起点
      re.has("HyperMD-quote") && -1 !== G
        && (r - K > 1 ? Z(r) : K = a),      // 普通 quote 只在 G 已被 callout 设置后才延长区间
      re.has("HyperMD-table-row") && (Z(r), r - Q > 1 && J(r), -1 === Y && (Y = r), Q = a),
      re.has("HyperMD-codeblock-begin") && -1 === j) { ... }
  if (re.has("HyperMD-codeblock-end") && -1 !== j) { ... new v6(...) /* 代码块 widget */ }
}
```

关键点：`G` 初值 `-1`，**唯一**把它设成真实位置的分支要求 `HyperMD-callout`。纯引用块 `G` 恒为 `-1`，`re.has("HyperMD-quote") && -1 !== G` 永远为假 → **不会建 widget**。

区间落地成 widget 的 `Z`：

```js
Z = function (i) {
  if (-1 !== G && K < i) {
    var r = m.sliceString(G, K), o = N6(S, e => e.text === r);
    b(G, K) || (o || (o = new y6(n, e, t, r)),     // ← new y6(...) = callout widget
               C.push(w({ widget: o, side: 1, block: !0 }, G, K)));  // block:true 的 replace 装饰
    o && (o.setPos(G, K), s.push(o));
    G = -1, K = -1;
  }
};
```

callout widget 类 `y6`（class 名 `"cm-callout"`）：

```js
y6 = function (e) {
  function t(t, n, i, r) { return e.call(this, t, n, r, "cm-callout") || this }
  m(t, e),
  t.prototype.getTypePos = ...   // 定位 "[!xxx]"
  t.prototype.getType     = ...  // 读 callout 类型
  t.prototype.updateType  = ...  // 改 callout 类型（dispatch）
  t.prototype.remove      = ...  // 整段删除
  t.prototype.initDOM     = function (t) { var i = e.prototype.initDOM.call(this, t); ... }
}
```

它继承自某个 embed-widget 基类，基类负责建 `cm-embed-block … markdown-rendered` 容器并用 markdown 渲染器填内容（DOM 证据见上）。

## 证据 3：光标进出 callout=源码/渲染切换

方法：`../spikes/research-probes/q3.js` —— 把选区放到 callout 标题行（`cm.dispatch({selection:{anchor: pos}})`）再读 DOM。

- 光标在 callout 内：`.cm-content` 下 **`cm-embed-block` 计数 = 0**；callout 各行还原成 `.cm-line`，标题行 = `cm-active HyperMD-callout HyperMD-quote HyperMD-quote-1`，正文 = `HyperMD-quote HyperMD-quote-1`（表格也还原成源码）。
- 光标移开（`anchor:1`）：`cm-embed-block cm-callout` 重新出现。

→ callout 用的正是「光标在内→源码、光标在外→widget」这一模式，**与本插件现有表格方案同构**（见 `src/editor/field.ts` 的 `buildDecorations`）。

## 证据 4：MarkdownRenderer 渲染引用块时块内容正常

`MarkdownRenderer.render(app, '> | a | b |\n> | --- | --- |\n> | 1 | 2 |', el, 'probe4.md', comp)` 实测输出（`../spikes/research-probes/rendertest.js`）：

```html
<blockquote dir="auto">
  <table> ... </table>
</blockquote>
```

→ **读取层（markdown 引擎）本身完全支持引用块内块级内容**；退化的只是 Live Preview 的语法模式。所以修复方向是「在 Live Preview 里自己接管引用块并调用 MarkdownRenderer」，而非改引擎。

---

## Q5：callout 内表格由谁渲染 / 能否塞进本插件 widget

- **由谁渲染**：Obsidian 的 `cm-callout` 块级 widget（`y6`），内部 `div.markdown-rendered` 容器由 MarkdownRenderer 填充。表格是 MarkdownRenderer 内建表格渲染器产出的普通 `<table>`（**无** `mdft-*` 类），只读、不可编辑。
- **能否塞进本插件 widget**：**卡在两个硬点**（均有 DOM 证据）：
  1. callout 渲染时，其整段被替换为 **单个 widget**，正文**没有 `.cm-line`**（`dom3.js`：callout 位置只有一个含 `<br>` 的占位 `.cm-line`）。CM6 的 `Decoration` 只能作用在文档行上，**无法对「已被 replace 掉的区间内部」再下装饰**。
  2. 若想覆盖 callout 区间，就得**整段接管**（用 `Prec.highest` 压过 Obsidian 的 `cm-callout`，机制与压过顶层原生表格 widget 相同，见 archive `spike-cdp-findings.md` 的 AC10）。但接管后必须**自己重造 callout**（标题、图标、可折叠、类型点击），否则只是把渲染换掉。
- **推论**：真正可行的只有「整段接管 callout → 用 MarkdownRenderer 复现 callout DOM（实测可复现，含 `data-callout` / 图标）→ 再把内层表格替换成本插件可编辑表格」。不能只接管内层表格。

## Caveats / 未验证

- `Zd`（line-prop 名）与 `$d`（语法树 node-prop 名）是压缩变量名，未逐一映射到语义；结论基于它们的**行为**（quote 行无块 prop）。
- 未详查 callout widget 基类的 `initDOM` 是否**直接**调 `MarkdownRenderer.render`（只确认了它产出 `.markdown-rendered` DOM，且内容与 `MarkdownRenderer.render` 输出一致）。DOM 等价性足以支撑结论。
- 未验证「`Prec.highest` 覆盖 `cm-callout`」是否稳定（顶层表格已验证，callout 未实测）。要实现须先 spike。
