# 研究期的 CDP 探针（存档）

这些是研究阶段用来取证的**一次性**脚本，从 `.scratch/`（未纳入 git）挪过来的，
只保留 `research/` 文档里**实际引用**的那几个，让引用可解析。

用 `node tools/cdp.mjs -f <file>` 驱动（Obsidian 需以 `--remote-debugging-port=9222` 运行）。

| 脚本 | 对应证据 |
|---|---|
| `dom3.js` | `quote-block-rendering.md` 证据 1：引用块 vs callout 的 DOM 结构对比 |
| `p3.js` | `quote-block-rendering.md` 证据 1 对照组：列表内代码块渲染、引用内不渲染 |
| `probe1.js` | `markdown-renderer-in-widget.md` §1：证明 `MarkdownRenderer` 不是全局量 |
| `rendertest.js` | `markdown-renderer-in-widget.md` §3：渲染能力覆盖矩阵（标题/表格/高亮/内链/嵌入/callout/数学） |
| `q3.js` | `blockquote-widget-editing.md` §3：callout 的光标进出切换实测 |
| `asarall.cjs` | `quote-block-rendering.md` 证据 2：反查 `obsidian.asar` 取装饰构造器源码 |

> 研究文档里写的是 `.scratch/xxx.js` 的路径，实际存档在本目录，文件名相同。
> 其余 24 个未被引用的迭代脚本已删除。
