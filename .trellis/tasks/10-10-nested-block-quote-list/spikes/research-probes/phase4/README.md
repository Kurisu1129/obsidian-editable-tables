# 阶段 4 验证探针（实施完成后）

| 文件 | 验证什么 | 结论 |
|---|---|---|
| `probe-blockonly.js` | 「块是列表项第一个子块」—— 含空列表项（单独一行 `-`）时的对齐 | 有正文的一级/二级项按实测列位对齐；**空列表项**（`-` 单独一行）Obsidian 不给 `HyperMD-list-line`，宿主本身不按列表渲染，插件同样不缩进 —— 与宿主一致 |
| `probe-perf-b.js` | 542 行、30 引用 + 30 表格的光标移动开销与快速路径 | dispatch 平均 2.58ms / p95 5.1ms / max 5.3ms；视口内 widget 被复用 |
| `probe-link.js` | 引用块 widget 内的内链 / 嵌入 DOM 与可点性 | `.internal-link` / `.external-link` 的 `pointer-events: auto`；嵌入 `is-loaded` |
| `probe-link-click.mjs` | 用 CDP 真实鼠标点击引用块内 `[[笔记]]` | 活动叶切到目标笔记 —— `ignoreEvent: true` 不阻断宿主的链接处理器（design.md §7.3 结论） |

运行前提：Obsidian 以 `--remote-debugging-port=9222` 启动，插件已部署到 spike-vault。
`probe-blockonly.js` 会在 vault 里创建 `probe-blockonly.md`（fixture 已被 .gitignore 覆盖）。
