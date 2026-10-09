# 调研：Obsidian Live Preview 的 CM6 扩展接入方式

> 供实现/检查阶段直接引用。本文只记录**可操作的技术事实与代码形态**，需求侧事实见 `../prd.md`。

## 1. 访问编辑器：无法替换，只能扩展

Obsidian 的编辑器是 CodeMirror 6，**插件无法整体替换它**。唯一的接入点是注入 editor extension。

三种拿到 `EditorView` 的方式：

```ts
// 1) 插件里注册全局扩展（推荐：对所有编辑器生效）
export default class MyPlugin extends Plugin {
  onload() {
    this.registerEditorExtension(tableExtension);
  }
}

// 2) 按 MarkdownView 取
const view = this.app.workspace.getActiveViewOfType(MarkdownView);
const editorView = (view?.editor as any)?.cm as EditorView;

// 3) 遍历所有叶子
this.app.workspace.iterateAllLeaves((leaf) => {
  if (leaf.view instanceof MarkdownView) {
    const editorView = (leaf.view.editor as any).cm as EditorView;
  }
});
```

**警戒**：`obsidian-codemirror-options` 因直接使用 CM5 API，随 CM6 迁移已失效。只用官方文档化的公开接口 + 公开 CM6 包。

## 2. 装饰（Decoration）：四种类型与两个提供者

| 装饰类型 | 用途 |
|---|---|
| `Decoration.mark` | 给已有元素加样式 |
| `Decoration.widget` | 插入自定义元素（不替换内容） |
| **`Decoration.replace`** | **隐藏或替换文档片段 —— WYSIWYG 的关键** |
| `Decoration.line` | 整行样式 |

两种提供者，选择规则：

- **`ViewPlugin`** —— 装饰只取决于视口内的内容。视口重算**之后**运行，因此**不能改变影响视口的东西**（不能插入块或换行）。性能更好。
- **`StateField`** —— 需要管理视口外的装饰，或改动会改变视口内容（如插入换行）。

> 本项目的表格 widget 是 `block: true` 的替换装饰，**会改变视口高度**，因此需要 `StateField`（或 `StateField` 提供 region + `ViewPlugin` 在视口内构建 widget 的混合形态）。

## 3. 块级 widget 与嵌套编辑器（核心技术路线）

CM6 作者 marijn 的结论：**WYSIWYG 表格可行，但必须把表格做成 block widget，并在单元格内嵌套多个内部编辑器** —— 因为 CM6 要求所有内容行排布在**单一列**中。

```ts
Decoration.replace({
  widget: new TableWidget(region),
  block: true,   // 块级：占据整块区域并可改变高度
});
```

现成参考实现：`@markwhen/codemirror-tables`（自 Joplin 富文本编辑器抽出）。其单元格点击即用嵌套 CM 编辑器。

### 嵌套编辑器与主编辑器同步的要点

1. **共享 history** —— 否则嵌套编辑器里的撤销会与主文档脱节。
2. **按单元格子文档偏移重映射变更集** —— 用 `iterChanges` 迭代变更，按偏移量重建 changeset 再转发给主 `EditorView`。
3. **限制单元格内的解析** —— 禁止单元格中出现多行块（标题、多行代码块等），例如移除部分 block parser。

## 4. 高度同步（最容易踩的坑）

块级 widget 必须向 CM6 报告**正确的 DOM 高度**，否则 CM6 的高度映射表（heightmap）与实际不符，表现为**点击时光标落到偏离数行的位置**。

```ts
const ro = new ResizeObserver(() => view.requestMeasure());
ro.observe(widgetDom);
```

已知具体陷阱（来自 grove 的架构文档实测）：

- 用 `display: contents` 作为宿主会导致 **0×0 高度**，光标落点偏差数行。修复方式是 `display: block` 并用 padding 代替 margin。
- 异步渲染需要给一个带**预估最小高度**的占位，避免闪烁与 heightmap 跳动。

> 这条直接对应验收标准 **AC6（光标不偏移）**，必须在实现早期就建立回归测试，不能留到最后。

## 5. 性能

- 用 `view.visibleRanges` **只处理视口内的内容**。
- 渲染结果按**源码 hash 做 LRU 缓存**（grove 的做法；`codemirror-rich-markdoc` 正是因为每次操作重算全部替换区域而未优化）。
- 对应验收标准 **AC8**。

## 6. 落盘格式的跨平台行为

| 载体 | `colspan` / `rowspan` | `class` / `style` / `bgcolor` |
|---|---|---|
| GitHub 渲染 API | **白名单放行** | **剥离** |
| Obsidian | 原生渲染 HTML 表格 | 保留 |
| HTML 标签内的 Markdown | **不解析**（GitHub 与 Obsidian 一致） | — |

推论：合并单元格用 HTML 是跨平台唯一可行解；代价是单元格内失去行内 markdown。

## 7. 参考实现

- `glifox/gnosis` —— CM6 的 WYSIWYG markdown 扩展包（含隐藏标记、防抖动、自定义换行）
- `@markwhen/codemirror-tables` —— 可交互表格 widget + 嵌套单元格编辑器
- `JoeChen2me/obsidian-nested-markdown-renderer` —— **本项目最直接的参考**：Live Preview 内渲染列表项下嵌套表格与缩进 callout，从不改写笔记内容，光标进入即还原源码。仅桌面端，Obsidian 1.12.7+

## 来源

- [Obsidian 开发者文档：Decorations](https://raw.githubusercontent.com/obsidianmd/obsidian-developer-docs/main/en/Plugins/Editor/Decorations.md)
- [Obsidian 开发者文档：View plugins](https://raw.githubusercontent.com/obsidianmd/obsidian-developer-docs/main/en/Plugins/Editor/View%20plugins.md)
- [CodeMirror 论坛：WYSIWYG table](https://discuss.codemirror.net/t/wysiwyg-table/9763/3)
- [CodeMirror 论坛：Nested editors, kind of](https://discuss.codemirror.net/t/nested-editors-kind-of/4654)
- [grove 编辑器架构文档](https://github.com/MorizMensi/grove/blob/main/docs/architecture/editor.md)
- [@markwhen/codemirror-tables](https://www.npmjs.com/package/@markwhen/codemirror-tables)
- [obsidian-nested-markdown-renderer](https://github.com/joechen2me/obsidian-nested-markdown-renderer)
- [GitHub Markdown colspan（Stack Overflow）](https://stackoverflow.com/questions/23571724/github-markdown-colspan/)
- [GFM 表格白名单实测](https://formatarc.com/en/blog/gfm-table-cheatsheet/)
- [Obsidian 论坛：如何在插件中获取 CodeMirror](https://forum.obsidian.md/t/how-get-codemirror-in-plugin/55197)
