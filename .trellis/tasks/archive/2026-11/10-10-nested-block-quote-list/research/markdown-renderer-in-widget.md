# Research: `MarkdownRenderer` 在 CM6 块级 widget 里能不能用（Q2）

- **Query**: MarkdownRenderer 的公开签名 / 生命周期 / 内链·嵌入·高亮的可用性 / 已知的坑。
- **Scope**: internal（真实 Obsidian 1.13.7 运行时实测）
- **Date**: 2026-10-10

## 结论优先

- **能用，且是官方公开 API**。但 `MarkdownRenderer` **不是全局量**（`window.MarkdownRenderer === undefined`）—— 插件里通过 `require('obsidian')` 取（模块导出含 `MarkdownRenderer` / `MarkdownRenderChild` / `Component`）。
- 签名（实测 `String(MarkdownRenderer.render)`）：`render(app, markdown, el, sourcePath, component) → Promise<void>`，**异步**。
- 渲染产物覆盖：标题、表格、围栏代码（带语法高亮 + `is-loaded`）、列表、内部链接（`a.internal-link`，`data-href`）、嵌入（`![[...]]` → `.internal-embed.markdown-embed.is-loaded`）、callout、数学。**在 detached（未挂载）元素上也正常**（内链照常解析）。
- 生命周期：用一个 `Component` 承载；**渲染前 `component.load()`**，**widget 销毁时 `component.unload()`**。嵌入会 `addChild` 到该 Component，`unload()` 会一并拆掉（实测 `_children` 1 → 0）。
- 坑：① `render` 是**追加**语义，重复渲染到同一 `el` 会**叠加内容**（实测 `first` + `second` 同时出现）→ 每次必须清容器或换新元素；② 不传 `Component` 时 Obsidian 会 `console.error` 警告「可能内存泄漏」；③ 异步 → widget 高度先未知，需占位 + `ResizeObserver`（见 `codemirror-widgets.md`）。

---

## 1. 访问方式（为什么不是全局）

实测（`../spikes/research-probes/probe1.js`）：

```
window.MarkdownRenderer = undefined
window.require('obsidian') → Error: Cannot find module 'obsidian'
app.plugins.plugins['editable-tables'] 存在（插件已加载）
```

但插件 bundle 里 `require("obsidian")` 正常（`spike-vault/.obsidian/plugins/editable-tables/main.js:31,375`）。原因：Obsidian 用**自带的 per-plugin require** 包裹插件代码，`window.require` 是 Electron 的，不认识 `obsidian` 这个模块 id。

**复现手法**（研究用，非产品代码）：写一个一次性 probe 插件，`onload` 里把模块暴露到 `window`，再 CDP 启用它：

> ⚠️ 这个 `probe-api` 插件是**抛弃式**的，测完已从 vault 删除，路径不再存在 ——
> **下面这段代码块就是它的全部源码**，照抄即可复现，不必去找文件。

```js
// spike-vault/.obsidian/plugins/probe-api/main.js（已删除，源码即本段）
const obsidian = require("obsidian");
module.exports = class extends obsidian.Plugin {
  async onload() { window.__probe = { module: obsidian, MarkdownRenderer: obsidian.MarkdownRenderer, Component: obsidian.Component, MarkdownRenderChild: obsidian.MarkdownRenderChild }; }
};
// CDP: await app.plugins.loadManifests(); await app.plugins.loadPlugin('probe-api'); await app.plugins.enablePlugin('probe-api');
```

`require('obsidian')` 导出共 **158** 项，与本任务相关的：`MarkdownRenderer`、`MarkdownRenderChild`、`Component`、`MarkdownPreviewRenderer`、`MarkdownPreviewView`、`MarkdownView`、`editorLivePreviewField`、`livePreviewState`、`editorInfoField`、`editorViewField`、`sanitizeHTMLToDom`、`renderMath`、`loadPrism`、`getLinkpath`。

## 2. 签名（实测原文，压缩）

```js
MarkdownRenderer.render = function (e /*app*/, t /*markdown*/, n /*el*/, i /*sourcePath*/, r /*component*/) {
  if (!(r && r instanceof mg)) {   // mg = Component
    // console.error: 'Plugin "..." is not passing Component in renderMarkdown.
    //   This is needed to avoid memory leaks when embedded contents register global event handlers.'
  }
  var l = WT(t), c = KT(l), u = RF(GT(l));
  n.appendChild(u);                              // 把渲染结果 append 进 el
  for (var h = [], p = { docId: Gd(16), sourcePath: i, frontmatter: c, promises: h,
        addChild: e => r && r.addChild(e), getSectionInfo: () => null, replace: () => null,
        containerEl: n, el: n, displayMode: !0 },   // displayMode:true → 块级渲染
      d = 0, f = AW.postProcessors; d < f.length; d++) { ... }   // 运行 postprocessor
  if (e && r) { ...                                    // app 与 component 都给了才处理嵌入
    var g = n.findAll(".internal-embed:not(.is-loaded)");
    ... W1.load({ app: e, linktext, sourcePath: i, containerEl: w, displayMode: !0, showInline: !0, depth: m })
    C && (p.addChild(C), h.push(C.loadFile()));
  }
  return h.length > 0 ? Promise.all(h).then() : Promise.resolve();   // 总是返回 Promise
};
MarkdownRenderer.renderMarkdown = function (e, n, i, r) { return t.render(null, e, n, i, r); };  // 旧签名，app 传 null（无嵌入处理）
```

- **参数**：`app: App`、`markdown: string`、`el: HTMLElement`、`sourcePath: string`（用于解析相对链接/嵌入，通常传当前笔记 path）、`component: Component`。
- **返回值**：`Promise<void>`；有嵌入时等所有嵌入 `loadFile()` 完成才 resolve。
- **不传 app 的 `renderMarkdown`** 是遗留 API：`app=null` → **不会处理嵌入**，且仍要求 `Component`。

## 3. 实测：渲染能力覆盖

`../spikes/research-probes/rendertest.js`：向一个 detached `<div>` 渲染一段混合 markdown，结果：

| 内容 | 结果 | 关键 class |
|---|---|---|
| `## Heading` | `<h2 data-heading="Heading" dir="auto">` | — |
| 管道表格 | `<table><thead>…<tbody>` | — |
| ```` ```js ```` | `<pre class="language-js"><code class="language-js is-loaded"><span class="token keyword">…` | 语法高亮已生效 |
| 列表 | `<ul><li dir="auto">` | — |
| `[[probe4]]` | `<a data-href="probe4" href="probe4" class="internal-link" target="_blank" rel="noopener nofollow">` | 内链解析成功 |
| `![[probe4]]` | `<span alt="probe4" src="probe4" class="internal-embed markdown-embed inline-embed is-loaded">` 内含完整嵌入内容 | 嵌入加载成功 |
| callout | `div.callout[data-callout=note] > .callout-title + .callout-content` | — |
| `$x^2$` | 渲染出数学容器 | `hasMath = true` |

要点：
- **detached 元素也可渲染**（`detachedReturnsPromise=true`、`detachedHasLink=true`）——不需要先挂到 document。
- `render` **追加**：同一 `el` 连续渲染两次 → `"<p>first</p><p>second</p>"`（**叠加**，非替换）。→ widget 里要么 `el.empty()` / `replaceChildren()` 后再渲染，要么每次 `toDOM` 都新建容器。
- `component._children`：无嵌入时 0；渲染 `![[probe4]]` 后 = 1；`component.unload()` 后 = 0。

## 4. 生命周期（`Component` / `MarkdownRenderChild`）

- `new Component()` → 有 `load()` / `onload()` / `unload()` / `onunload()` / `addChild()` / `removeChild()` / `register*()`。
- `MarkdownRenderChild` 构造：`function t(t){ ... this.containerEl = t }` —— 即 `new MarkdownRenderChild(containerEl)`；它继承 `Component`，给嵌入/子渲染用。
- 正确姿势（与 `WidgetType.destroy` 对齐）：

```ts
// toDOM 内
const comp = new Component();
comp.load();
MarkdownRenderer.render(app, md, host, sourcePath, comp).then(() => view.requestMeasure());
// destroy(dom) 内
comp.unload();          // 拆掉所有 addChild 的嵌入/子组件
```

- 注意：`render` 的嵌入处理**只在 `app && component` 都给了**时才走；所以两者都要传。

## 5. 已知的坑 / 风险

| 坑 | 证据 / 说明 |
|---|---|
| 异步竞态 | `render` 立即 append 同步部分，随后 Promise 处理嵌入。widget 若在 resolve 前被 `destroy`，AsyncEmbed 的 `addChild` 会在已卸载的 Component 上发生。需在 destroy 里 `unload()` 并忽略迟到回调。 |
| 重复渲染叠加 | 实测 `first`+`second` 并存。必须清容器。 |
| 高度未知 | 块级 widget 必须先给占位高度，渲染完 `view.requestMeasure()`（`codemirror-widgets.md` 的 heightmap 契约）。 |
| 未传 Component | 会 `console.error`，且嵌入的全局事件处理器不被回收 → 泄漏。 |
| `contain: paint` 裁剪 | Obsidian 对非编辑块级 widget 强制 `contain: paint !important`（见 `codemirror-widgets.md`）。MarkdownRenderer 产物里的悬浮/溢出元素会被裁。 |
| 内链点击 | 渲染出的 `a.internal-link` 走 Obsidian 的默认处理器；在 widget（`ignoreEvent:true`）内需确认点击可用（未在本轮实测点击）。 |

## Caveats / 未验证

- 未实测在**真正的 `WidgetType.toDOM` 上下文**里调用（本轮是从 CDP 用同样的 `app`+`Component` 调用，行为应一致，但未在 widget 生命周期内闭环验证）。
- 未实测 widget 内内链/嵌入**点击**是否触发跳转（只验证了 DOM 结构）。
- `renderMarkdown`（旧签名）的嵌入行为只从源码推断，未单独实测。
