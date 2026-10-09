# 执行计划：Live Preview 内的可编辑表格

> 设计见 `design.md`，需求与验收见 `prd.md`。阶段划分依据 D-A（嵌套优先）与 D-B（v1 不做单元格文本输入）。

## 阶段 0：工程脚手架与测试台

- [ ] `manifest.json` —— 置 `isDesktopOnly: true`（v1 不做移动端）
- [ ] `package.json` / `tsconfig.json` / `esbuild.config.mjs` —— 标准 Obsidian 插件构建
- [ ] `styles.css` —— 表格网格与工具条样式
- [ ] 建立 **Obsidian 测试 vault**，**纳入 git**（写盘前的安全网）
- [ ] 建立 fixture 样例文件（见下方清单）
- [ ] vitest 配置

**验证**：`npm run build` 产出 `main.js`；插件可在测试 vault 加载且控制台无报错。

## 阶段 0.5：Spike —— 替换装饰能否压过原生表格渲染器〔**必经门禁**〕

消灭本方案**唯一的未知数**（D-A / AC10）。

**已就绪的基础设施**（本次规划期已搭建，见 `research/spike-cdp-findings.md`）：

- 测试 vault：`F:\workplace\obsidian-md-formatter\spike-vault`，已含 `top-level.md`（顶层表格）与 `nested.md`（列表项下缩进表格）
- CDP 通道：`cmd /c start "" "D:\obsidian\Obsidian.exe" --remote-debugging-port=9222`
- CDP 客户端：`%TEMP%\cdp.mjs`（node 内置 WebSocket，零依赖，支持 `-f <file>`）

**待做**：

- [ ] 在脚手架内用 `Prec.highest` 包裹一个替换装饰，覆盖**顶层**表格区间
- [ ] 断言我方 widget 存在且 `.cm-table-widget` 不存在（原生未接管）
- [ ] 覆盖三种时机：初次打开文件、编辑表格外围文本后、切换文件再回来
- [ ] 回归确认：callout / 代码块 / mermaid / 数学块（同属 `cm-embed-block` 家族）**未被连带影响**
- [ ] 记录结论与 Obsidian 版本号

**结论分支**：

- ✅ 稳定胜出 → v1 按**全场景**实施，阶段 2 覆盖顶层 + 嵌套
- ❌ 被压过或行为不稳定 → **D3 + D5 组合不可达**，停止并回到用户重新决策（现实选项：退回「顶层保持原生渲染」的混合形态）

> 这是必经门禁，不是可选项。**未取得明确结论不得进入阶段 2。**

## 阶段 1：模型层（纯函数，无 UI）

- [ ] `model/grid.ts` —— `TableGrid` / `Cell` 类型与结构操作（增删行列、列对齐、合并、拆分）
- [ ] `model/parsePipe.ts` —— 管道表格 → `TableGrid`
- [ ] `model/parseHtml.ts` —— HTML 表格 → `TableGrid`
- [ ] `model/serializeHtml.ts` —— `TableGrid` → HTML `<table>`
- [ ] `model/roundtrip.ts` —— 往返不变式校验辅助
- [ ] 单元测试：全部 fixture 满足 `parse(serialize(g)) ≡ g`；span 无重叠、无越界

**验证**：`npx vitest run` 全绿。此阶段不接触 Obsidian，可完全离线验证。

## 阶段 2：只读渲染（嵌套表格）

- [ ] `editor/tableScanner.ts` —— 行级扫描，识别**顶层**与**列表项下**的管道表格（后者覆盖 2 空格与 4 空格缩进）
- [ ] `editor/tableField.ts` —— `StateField` 缓存 region（按 doc 版本 + 源码 hash）
- [ ] `editor/decorations.ts` —— 光标在 region 外时产出 `Decoration.replace({widget, block:true})`；光标进入时不产出装饰
- [ ] `widget/tableWidget.ts` —— `WidgetType`，`TableGrid` → DOM
- [ ] `editor/heightSync.ts` —— `ResizeObserver` + `view.requestMeasure()`；宿主用 `display: block` + padding

**验证**（手工，AC1/AC2/AC6）：光标移出表格时渲染为网格、移入时还原源码；**列表层级与缩进完全不变**；在表格前后各插一行文本后，单元格点击落点与源码位置一致。

> 此阶段完成后已达到 `nested-markdown-renderer` 的**只读能力对等**，是一个可独立演示的里程碑。

## 阶段 3：结构操作与写回

- [ ] `widget/toolbar.ts` —— 浮动工具条
- [ ] 增删行列 / 列对齐 / 合并 / 拆分，接 `grid.ts`
- [ ] `serializeHtml` 写回：`view.dispatch` 替换 region，**逐字节保留 `region.indent`**
- [ ] `widget/` 上标出来源格式（R8 的可见标识）

**验证**（手工，AC3/AC4/AC5）：操作后落盘为 `<table>`，`colspan`/`rowspan` 自洽；产出的文件在 GitHub 上合并结构正确（人工验收一次）。

## 阶段 4：单元格内嵌编辑器（v1 核心风险）

- [ ] `widget/cellEditor.ts` —— 单元格内嵌 CM6 `EditorView`
- [ ] 与主编辑器**共享 history**，避免撤销栈脱节
- [ ] 变更集同步：用 `iterChanges` 按单元格子文档偏移重映射后转发主 `view.dispatch`
- [ ] 限制单元格内的解析：禁止多行块（标题、多行代码块）
- [ ] IME 验证：中文输入法连续输入、候选词选择、组合态不丢字

**验证**（手工，**AC6 为硬门禁**）：在表格前后各插入文本行后，点击任一单元格的落点必须与源码位置一致；单元格内撤销/重做与主文档撤销栈一致；中文输入法连续输入无丢字。

> **此阶段不通过 AC6 即停止** —— 回退为只交付结构操作，不得带病推进。

## 阶段 5：护栏

- [ ] 畸形输入策略：**不渲染、不写盘**，console 警告 `[md-formatter]` 前缀（AC7）
- [ ] 断言只读操作（打开/滚动/切换文件）零磁盘写入（AC9）
- [ ] 性能：仅视口内构建 widget + LRU 缓存（AC8）
- [ ] `README.md` 与设置项说明

## Fixture 清单

| 文件 | 覆盖 |
|---|---|
| `top-level.md`（spike vault 已有） | 顶层管道表格 —— v1 接管，用于 AC1 / AC10 |
| `nested.md`（spike vault 已有） | 列表项下缩进表格 —— 用于 AC2 |
| `fx-nested-2space-pipe.md` | 列表项下 2 空格缩进表格（AC2） |
| `fx-nested-4space-pipe.md` | 列表项下 4 空格缩进表格（AC2） |
| `fx-malformed-indent.md` | 畸形缩进 —— 应回退且文件不变（AC7） |
| `fx-existing-html.md` | 既有 HTML 表格（含 `colspan`/`rowspan`）—— 必须能正确解析 |
| `fx-merge-target.md` | 合并/拆分操作与 GitHub 验收（AC4/AC5） |
| `fx-cell-edit.md` | 单元格原地编辑、撤销栈一致性、中文输入法（阶段 4） |

## 完成情况（实施期回填）

全部阶段已完成。验收由自动化套件执行，非人工抽查。

| 阶段 | 状态 | 证据 |
|---|---|---|
| 0 脚手架 | ✅ | CM6 全部 external，版本锁定到 Obsidian 的 peerDependencies |
| **0.5〔门禁〕** | ✅ **通过** | 三种时机下原生 `.cm-table-widget` 计数恒为 0（AC10） |
| 1 模型层 | ✅ | 38 个 vitest 用例，含往返不变式与 span 自洽性 |
| 2 只读渲染 | ✅ | 嵌套表格渲染 + 缩进保留（AC2）；视觉与原生逐像素一致 |
| 3 结构操作与写回 | ✅ | 增删行列 / 对齐 / 合并拆分（AC4）；块外字节不变（AC3） |
| 4 单元格编辑 | ✅ | **未按原计划用内嵌 CM6 编辑器**，改用 `contenteditable` —— 真实中文 IME 组合输入实测无丢字（F20） |
| 5 护栏 | ✅ | 畸形输入拒绝且不写盘（AC7）；只读零写入（AC9）；50 表视口裁剪（AC8） |

**超出原计划的追加项**：R9 可撤销（AC11）、R11 front matter 不可侵犯（AC12）、R12 编辑不丢失（AC13）、R13 输入不致命。均为实施期实测发现问题后纳入验收。

## 验证命令

```bash
npm test                     # 模型层单测：47 通过
npm run typecheck
./scripts/restart-obsidian.sh
npm run build && ./scripts/deploy.sh
node scripts/acceptance.mjs  # 真实 Obsidian 上 AC1–AC13：13/13 通过
```

**独立复核**：实现完成后由 `trellis-check` 跑了一轮独立复核，找出 5 条会真实损坏用户数据的问题（含 YAML front matter 被当作表格、单元格输入被工具栏操作静默丢弃），全部已修复并固化为测试。清单见 `design.md` §7。

**实施期修正**：表格列宽改取所有行的最大列数、续行按"管道形状须与表头一致"判定、`WidgetType.eq` 增加偏移量比较、单元格编辑器改用 contenteditable、工具栏改置于 widget 盒内。

## 高风险文件与回滚点

| 文件 | 风险 |
|---|---|
| `editor/heightSync.ts` | 高度失准 → **光标偏移数行**，且在后续阶段才显形 |
| `editor/decorations.ts` | 与 Obsidian 原生渲染器的装饰冲突面 |
| `model/serializeHtml.ts` | **直接写盘**，数据安全相关 |

每个阶段结束都是一个可回滚点。落盘影响仅限被编辑过的表格，每张表的改动是独立 diff，可逐张 `git checkout`。

## 开工前复查

- [ ] 测试 vault 已建立且**已纳入 git**
- [ ] fixture 全部就位
- [ ] 确认目标 Obsidian 版本（基线 ≥ 1.12.7）
- [ ] **阶段 0.5 的 spike 已取得明确结论** —— 据此确定 v1 是「全场景接管」还是回退为「只做嵌套」（D-A）

## 后续（不在本任务内）

- **后续切片**：列表项内嵌非表格块（代码块、引用）、callout 内表格修复
