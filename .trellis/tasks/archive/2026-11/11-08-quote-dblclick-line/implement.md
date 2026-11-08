# 实施计划：引用块双击定位到所点行

## 阶段 1：纯函数层

1. `src/model/quoteLineMap.ts`
   - `projectQuoteLines(source, indent)`：从 `innerTable.ts` 的投影循环抽取；`planInnerTables` 改为复用（行为不变）。
   - `scanQuoteBlocks(lines)`：段落 / 标题（ATX + Setext）/ 列表（顶层 itemStarts）/ 围栏代码 / 嵌套引用 / 表格 / HTML 块 / 分割线。
   - `resolveQuoteLine(blocks, renderedCount, blockIndex, itemIndex?, itemCount?)`。
2. `tests/quoteLineMap.test.ts`：
   - 投影：`> `、`> > `、`  > `、lazy、prefix 长度与 starts 偏移；
   - 块扫描：上述每种块；
   - 配对：列表第 N 项、块数不一致返回 null、越界返回 null、列表项数不一致退到块首。
3. 验证：`npm test`（应 104 + 新增全绿）。

## 阶段 2：接入 QuoteWidget

1. `src/widget/quoteWidget.ts` 的 `dblclick`：
   - 取 `body` 的直接 `<blockquote>`（`:scope > blockquote`）；
   - 点击目标爬到 root 直接子元素得到 `blockIndex`；列表内用 `closest('li')` 与父列表的直接 LI 序号；
   - 用 `scanQuoteBlocks` + `resolveQuoteLine` 得到内容行；
   - 绝对位置 = `posAtDOM(wrap, 0)` + `starts[line]` + `prefixes[line].length`；
   - 任何一步失败 → 保持 `posAtDOM(wrap, 0)`；
   - dispatch selection + `scrollIntoView: true`。
2. 验证：`npm run typecheck && npm run build && ./scripts/deploy.sh`。

## 阶段 3：真机冒烟（CDP 探测）

用 `scripts/probe-quote-dom.mjs` 同类脚本确认：
- 外层 `<blockquote>` 的子节点顺序与源码块一致；
- 列表直接 `<li>` 与 `itemStarts` 数量一致。

## 阶段 4：验收

1. `scripts/acceptance.mjs` 新增：
   - **AC40** 引用内列表第 3 项：真实双击 → widget 数 0、`getCursor().line` 等于该项源码行；
   - **AC41** 引用内段落：双击 → 光标行等于段落首行；
   - **AC42** 含嵌入的引用：双击不抛错、光标落在引用区间内；
   - AC33 汇总扩展到 AC40–AC42（标题同步）。
2. 运行 `node scripts/acceptance.mjs`，目标全绿。

## 阶段 5：文档与收尾

1. README：引用块交互说明补一句"双击落在所点行"；验收编号更新。
2. `.trellis/spec/frontend/codemirror-widgets.md`：补"渲染块 → 源码行映射"模式与保守回退契约。
3. 删除临时 probe 脚本；`npm test` / `typecheck` / `build` / `deploy` / 验收全绿后提交、归档、记 journal。

## 验证命令

```bash
npm test
npm run typecheck
npm run build && ./scripts/deploy.sh
node scripts/acceptance.mjs
```

## 回滚点

- 阶段 1–2 后：若块扫描误判频繁，删除 dblclick 映射，恢复固定块首（纯函数可保留但不用）。
- 验收 AC26/AC32 若回归，优先修映射或扩大回退条件，不改动选字/复制逻辑。

## 风险清单

| 风险 | 缓解 |
|---|---|
| 自写扫描与渲染器不一致 | 块数不一致一律回退；单测覆盖 |
| 列表项配对错位 | 顶层 LI 数与 itemStarts 数不一致时退到列表首行 |
| 偏移漂移 | 双击时 `posAtDOM` 实时解析 |
| 与选字/复制冲突 | 只改 dblclick 分支，AC26/AC32 回归 |

## 完成情况（实施期回填）

| 项 | 状态 | 证据 |
|---|---|---|
| 纯函数映射 | 完成 | `src/model/quoteLineMap.ts`；`tests/quoteLineMap.test.ts` 18 例；`npm test` 122/122 |
| `projectQuoteLines` 抽取复用 | 完成 | `innerTable.ts` 改用共享投影，既有 10 个单测不变通过 |
| 双击接线 | 完成 | `quoteWidget.ts` `sourceAnchorForClick`；真机 probe：列表第 3 项 → 行 6，段落 → 行 8，混合列表回退 → 行 2 |
| 验收 AC40–AC42 | 完成 | `node scripts/acceptance.mjs` **42/42 通过**（AC40 列表第 3 项→行 6；AC41 段落→行 8；AC42 混合列表 4 块 vs 3 块→回退行 2；AC33 汇总全绿） |
| 文档 / spec | 完成 | README 与 `codemirror-widgets.md` 已更新 |
