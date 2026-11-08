# 实施计划：表格编辑写回 Markdown 与导出 md

## 阶段 0：准备（只读）

1. 阅读 `.trellis/spec/frontend/data-safety.md`（唯一写盘路径 / source 校验 / 零写入）与 `.trellis/spec/frontend/codemirror-widgets.md`（widget / 工具栏 / 引用前缀）。
2. 记录基线：`npm test` 73/73；`node scripts/acceptance.mjs` 34/34。
3. 确认 `scripts/acceptance.mjs` 中 AC29–AC31 对 `<table>` 的断言位置，后续同步改为管道语法。

## 阶段 1：管道序列化器（纯函数）

1. 新增 `src/model/serializePipe.ts`：
   - `canSerializePipe(grid)`：按设计文档 2.1 的 7 条条件；
   - `serializePipeTable(grid, indent)`：表头 / 分隔行（colAlign）/ 数据行，逐行加 indent；
   - 转义 `|`（含反斜杠连跑规则）；
   - `serializePipeTableString` 辅助。
2. 新增 `tests/serializePipe.test.ts`：
   - `parsePipeTable → serializePipeTable → parsePipeTable` 网格等价（文本、对齐、hasHeader）；
   - 对齐四种标记；
   - 单元格内含 `|` 的往返；
   - 反斜杠 + 管道 → `canSerializePipe === false`；
   - 合并 / 跨行 / 无表头 / 换行 / raw 含 `|` → false；
   - indent（`  `、`> `、`> > `）；
   - 空单元格、单列表格。
3. 验证：`npm test`。

## 阶段 2：写回策略

1. `src/editor/writeback.ts`：
   - `commitGrid` 增加 `opts: { forcePipe?: boolean }`；
   - 按设计文档 2.2 的决策表选择序列化器；
   - 更新一次性提示文案（合并单元格才降级 HTML）。
2. 新增/补充 `tests/writeback` 相关纯逻辑测试（若现有测试结构允许）；至少保证序列化决策可单测——必要时把决策抽成纯函数 `chooseSerializer(regionKind, grid, forcePipe)` 放在 model 层。
3. 验证：`npm run typecheck && npm test`。

## 阶段 3：单元格规范化与工具栏「转 MD」

1. `src/widget/tableEditor.ts`：
   - `foldPendingEdit` 用 `innerText/textContent` + `replace(/\s+/g, ' ').trim()` 折叠换行；
   - 工具栏在 `tableKind === 'html'` 时增加「转 MD」按钮：
     - 可用性 `canSerializePipe(state.grid)`；禁用时 title 说明原因；
     - 点击 `foldPendingEdit` → `currentRegion()` → `commitGrid(..., { forcePipe: true })`；
     - 成功 / 失败 Notice。
2. 真机冒烟（CDP）：普通 pipe 表格编辑后源文件仍是管道；合并后变 HTML；拆分后点「转 MD」回到管道。
3. 验证：`npm run typecheck && npm run build && ./scripts/deploy.sh`。

## 阶段 4：Markdown 导出

1. 新增 `src/model/exportMarkdown.ts`：按设计文档 2.4 实现 `exportMarkdown(source)`。
2. 新增 `tests/exportMarkdown.test.ts`：
   - 顶层 HTML 表格可转换 / 合并表格保持；
   - 引用内 HTML 表格转换为 `> | … |`；
   - front matter、围栏代码块、普通段落逐字节不变；
   - 计数正确；多个表格的偏移应用正确。
3. `src/main.ts` 注册两个命令（复制 / 导出文件），实现剪贴板与 Blob 下载；失败处理。
4. 真机验证：
   - 通过 CDP 拦截 `navigator.clipboard.writeText`，执行 `editable-tables:copy-as-markdown`，检查捕获文本；
   - 拦截 `HTMLAnchorElement.prototype.click`，执行 `editable-tables:export-as-markdown`，检查下载名与 blob 内容；
   - 确认原笔记字节不变、写入计数为 0。
5. 验证：`npm run typecheck && npm test`。

## 阶段 5：验收套件

1. 更新 AC29–AC31：引用内 pipe 表格编辑后断言 `> | … |`（不再断言 `> <table>`）。
2. 新增：
   - **AC34** 顶层 pipe 表格编辑后仍为管道语法、对齐保留、表格外字节不变、重新加载仍可编辑；
   - **AC35** 合并 → HTML（`colspan`）；拆分 → 仍 HTML；点「转 MD」→ 管道；`Ctrl+Z` 撤销；
   - **AC36** 引用内 pipe 表格编辑后为 `> | … |`，列表内引用 / 嵌套引用前缀保留；
   - **AC37** 复制为 Markdown：clipboard 捕获文本正确、原文件不变；
   - **AC38** 导出为 Markdown 文件：文件名 / blob 内容正确、原文件不变；
   - **AC39** AC1–AC38 全量回归（跳过不存在的编号）。
3. 运行 `node scripts/acceptance.mjs`，目标全绿。

## 阶段 6：文档与收尾

1. README：
   - 「存储格式与代价」改写：编辑后优先保持管道语法，合并才用 HTML；
   - 用法增加「转 MD」按钮；
   - 新增「导出 Markdown」一节（两个命令）；
   - 已知边界更新（HTML 表格、无表头、单元格内联格式不渲染）；
   - 验证小节 AC 编号与测试数更新；
   - 结构树加入 `serializePipe.ts` / `exportMarkdown.ts`。
2. `.trellis/spec/frontend/data-safety.md`：补"写回格式选择"契约（管道优先、不可表示才 HTML、导出只读）。
3. `.trellis/spec/frontend/codemirror-widgets.md`：补"工具栏动作与导出命令"的可复用模式（如需）。
4. `npm test`、`npm run typecheck`、`npm run build`、`./scripts/deploy.sh`、验收全绿后提交。

## 验证命令

```bash
npm test
npm run typecheck
npm run build && ./scripts/deploy.sh
./scripts/restart-obsidian.sh   # 必要时
node scripts/acceptance.mjs
```

## 回滚点

- 阶段 1–2 后：若管道往返有任何字节不安全，回退 `commitGrid` 到无条件 HTML，序列化器保留但不用。
- 阶段 3 后：若工具栏按钮在引用内表格导致布局/交互问题，可先只保留正文表格按钮。
- 阶段 4 后：导出命令与写回互不依赖，可单独移除。

## 风险清单

| 风险 | 缓解 |
|---|---|
| 管道转义与 `splitRow` 不一致 | 拒绝反斜杠+管道；单测覆盖 `|` / 空单元格 / 对齐 |
| 引用前缀丢失 | 序列化逐行加 `region.indent`；AC36 覆盖三种前缀 |
| 编辑后表格被意外规范化 | 只在用户实际编辑/转换时发生；表格外字节逐字节断言 |
| 导出误改原文件 | 导出只读 `editor.getValue()`；验收统计写入次数 |
| 下载在 Obsidian 里被拦截 | 验收拦截 anchor 验证 blob；若真机不触发，退回"仅复制"并在 README 说明 |
| 老 HTML 表格无表头无法转 | 按钮禁用 + title 说明；导出保留 HTML 并计数 |

## 完成情况（实施期回填）

| 项 | 状态 | 证据 |
|---|---|---|
| 管道序列化器 | 完成 | `src/model/serializePipe.ts`；`tests/serializePipe.test.ts` 22 例（往返、对齐、转义、拒绝条件、indent、`chooseWriteFormat`） |
| 写回策略 | 完成 | `commitGrid(..., { forcePipe })` + `chooseWriteFormat`；`npm run typecheck` 通过 |
| 转 MD 按钮 | 完成 | `tableEditor.convertToMarkdown`；仅 `tableKind === 'html'` 显示，不可表示时禁用并说明；AC35/AC36 真机通过 |
| Markdown 导出 | 完成 | `src/model/exportMarkdown.ts` + 两个命令；`tests/exportMarkdown.test.ts` 9 例；AC37/AC38 真机通过 |
| 验收 AC34–AC38 | 完成 | `node scripts/acceptance.mjs` **39/39 通过**（AC1–AC27、AC29–AC38；AC33 为汇总） |
| 文档 / spec | 完成 | README、`data-safety.md`、`codemirror-widgets.md` 均已更新 |
| 单元测试 | 完成 | `npm test` 104/104（4 个文件） |
