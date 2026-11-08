# Research: 运行时 API 枚举（渲染进程）

- **Query**: 对 `window.app` 及渲染进程可用 API 做一次枚举，记下相关的。
- **Scope**: internal（真实 Obsidian 1.13.7 运行时，CDP 实测）
- **Date**: 2026-10-10

## 结论优先

- `window.app` 是完整 `App` 实例，可直接用（`app.vault` / `app.workspace` / `app.commands` / `app.plugins` / `app.metadataCache`）。
- **`MarkdownRenderer` 不是全局量**，只能用插件的 `require('obsidian')` 取（见 `markdown-renderer-in-widget.md`）。
- 渲染进程另有几个有用的全局构造器：`CodeMirror`(CM5)、`moment`、`TurndownService`、`DOMPurify`、`CodeMirrorAdapter`。**没有** CM6 的全局（CM6 需插件自带/打包）。
- Obsidian 的 `require('obsidian')` 导出 **158** 项；关键项见下。

## 1. `window.app`（App 实例）

探测命令：`node tools/cdp.mjs "Object.keys(app)"`（`../spikes/research-probes/probe1.js`）。

顶层键（40 个，节选相关）：

```
vault, workspace, fileManager, metadataCache, metadataTypeManager, keymap, scope,
commands, hotkeyManager, plugins, setting, internalPlugins, viewRegistry, embedRegistry,
dom, customCss, dragManager, renderContext, secretStorage, statusBar, lastEvent, title
```

- `app.workspace.getLeavesOfType('markdown')` / `getLeaf(false)` / `getActiveFile()` / `iterateAllLeaves()` —— 定位编辑器。
- `app.vault.create/modify/read/getAbstractFileByPath` —— 测试文件读写（spike-vault）。
- `app.commands.commands` / `executeCommandById` —— 含 `editor:table-*` 原生命令（见 archive `spike-cdp-findings.md`）。
- `app.plugins.plugins[id]` / `manifests` / `loadManifests()` / `loadPlugin(id)` / `enablePlugin(id)` / `disablePlugin(id)` —— 研究期启用 probe 插件用。
- `app.renderContext = { hoverPopover, app }`。

### 拿到 CM6 EditorView（`editMode.cm`）

`leaf.view.editMode`（Live Preview / Source 编辑模式对象）的 own keys 含：`cm`(=`EditorView`)、`editor`、`livePreviewPlugin`(数组，Obsidian 自带的 CM6 扩展列表)、`localExtensions`、`propertiesExtension`、`sourceMode`(boolean，**false=Live Preview**，true=Source)。

- `editMode.cm.state.doc` / `.selection` / `.field(...)` / `dispatch` —— 读写文档。
- `editMode.cm.contentDOM` / `scrollDOM` —— DOM 测量。
- `leaf.view.previewMode.renderer` —— **读取视图**渲染器（`MarkdownPreviewRenderer`），有 `parseSync` / `queueRender` / `onRender` 等；用于研究读取视图行为。
- `leaf.view.getMode()` 返回 `'source'` 表示编辑态；Live Preview 与否看 `editMode.sourceMode`（false = Live Preview）。切换命令：`markdown:toggle-preview`（读取/编辑）、`editor:toggle-source`（Live Preview/Source）。

## 2. `require('obsidian')` 导出（158 项，相关节选）

`window.__probe.module`（probe 插件注入，见 `markdown-renderer-in-widget.md`）。

渲染相关：

```
MarkdownRenderer, MarkdownRenderChild, MarkdownPreviewRenderer, MarkdownPreviewView,
MarkdownView, renderMath, finishRenderMath, loadMathJax, loadMermaid, loadPrism,
sanitizeHTMLToDom, htmlToMarkdown, Component, BaseComponent, RenderContext,
App, Plugin, PluginSettingTab, ItemView, View, Workspace, WorkspaceLeaf, Vault, TFile, TFolder,
Notice, Modal, Menu, Setting, ...
```

编辑器 / Live Preview 相关（**本任务最相关**）：

```
editorLivePreviewField   // StateField<boolean>：该编辑器是否处于 Live Preview
livePreviewState         // ViewPlugin：Live Preview 运行态对象
editorInfoField          // StateField<MarkdownFileInfo>
editorViewField          // StateField<EditorView>
CodeMirror(全局，CM5), editorEditorField
```

- `editorLivePreviewField` 实测：在 `probe4.md` 的 CM state 上 `state.field(editorLivePreviewField) === true`（`editorLivePreviewField.constructor.name === 'e'`，即内部 ViewPlugin/StateField 包装）。
- 未用到的导出（如 `getLanguage` / `parseYaml` / 一堆 `*Value` 属性类型）与本任务无关。

## 3. 其它全局量

```
CodeMirror         function   // CM5（Obsidian 仍保留，供旧模式/模式查找）
CodeMirrorAdapter  function
moment             function
TurndownService    function
DOMPurify          function
```

**没有** CM6 (`@codemirror/*`) 全局；CM6 类必须由插件 bundle 自带（本插件已 bundle，见 `spike-vault/.obsidian/plugins/editable-tables/main.js`）。

## 4. CDP 复现配方

客户端：`node tools/cdp.mjs "<expr>"` 或 `-f <file.js>`；`--shot <out.png>` 截图。观测端口 `http://127.0.0.1:9222`。

本任务用到的脚本（`../spikes/research-probes/`，均为研究临时文件）：

| 脚本 | 作用 |
|---|---|
| `probe1.js` | app keys / globals / 插件列表 |
| `dom3.js` | 打开 `probe4.md`，遍历 `.cm-line` + 找 `.callout` / `table` |
| `p3.js` | `probe3.md` 行 class（引用内代码块 vs 列表内代码块） |
| `rendertest.js` | `MarkdownRenderer.render` 能力覆盖 |
| `q3.js` | callout 光标进出切换 + render 边界（detached/重复/卸载） |
| ~~`indent.js`~~ | 列表内代码块/引用块的缩进几何 —— **未存档**（`.scratch/` 清理时漏了）。该测量已被门禁 0.2 覆盖且结论更完整，见 `spike-0-findings.md`，无需重跑 |
| `asarall.cjs` | 切片 `obsidian.asar` 反查源码（**大窗口必须切片，`grep -o` 会超时**） |

## Caveats

- 研究期产物**已清理**：`.scratch/` 与 `probe-api` 插件都不在了。
  被本文档引用的脚本已挪到 `../spikes/research-probes/`（原 `.scratch/` 路径已失效）；
  `probe-api` 是抛弃式插件，源码内嵌在 `markdown-renderer-in-widget.md` 里，直接照抄即可。
- `require('obsidian')` 的 158 项未逐条分类；只列了与渲染/编辑器相关者。
