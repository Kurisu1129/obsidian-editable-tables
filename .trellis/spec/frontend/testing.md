# 测试约定

本项目的测试分两层，**缺一不可**。

## 第一层：模型层纯函数单测

`src/model/` 下所有文件**不得** import `obsidian` 或 `@codemirror/*`。它们只处理字符串与数据结构，因此可以在纯 Node 下用 vitest 直接跑。

```bash
npm test          # 38 个用例，覆盖扫描 / 解析 / 序列化 / 网格操作 / 往返不变式
npm run typecheck
```

**契约**：任何进入 `src/model/` 的新逻辑都必须可单测。一旦发现某段逻辑没法脱离浏览器测试，说明它被放错了层。

必测不变式：

| 不变式 | 断言方式 |
|---|---|
| 往返稳定 | `serialize(parse(serialize(g))) === serialize(g)` |
| span 自洽 | 任意连续结构操作后，`covered` 单元格的 span 恒为 1；无越界、无重叠 |
| 不丢内容 | 合并单元格时文本被拼接而非丢弃 |
| 宽度规则 | 列数不一致的表格取所有行的**最大**列数 |

## 第二层：真实编辑器验收（CDP）

`scripts/acceptance.mjs` 通过 DevTools Protocol 驱动**真实运行中的 Obsidian**，逐条断言 PRD 的验收标准。没有 mock。

```bash
./scripts/restart-obsidian.sh          # 以 --remote-debugging-port=9222 启动
npm run build && ./scripts/deploy.sh
node scripts/acceptance.mjs
```

能力：打开文件、读 DOM、派发真实鼠标点击与按键、模拟中文 IME 组合输入、统计磁盘写入次数。

---

## 环境陷阱（每条都曾造成误判）

> **Warning**：`vault.modify()` 与编辑器的防抖自动保存存在竞态。
> `modify` 写入新内容后，编辑器缓冲区里的旧内容可能被自动保存**覆盖回去**，
> 于是测试运行的其实是上一轮的文本。**重置文档请直接用 `editor.setValue()` 并回读校验**。

> **Warning**：应用状态会累积污染。脏缓冲区、残留撤销栈、堆叠的标签页都会让结果失真，
> 且症状表现为"插件坏了"。**结果可疑时先重启 Obsidian**，不要急着改代码。

> **Warning**：`editor:undo` / `editor:redo` **不是注册命令**（`app.commands.commands` 里查不到）。
> 撤销绑定在键位上。验证撤销必须派发真实按键事件：
> Windows 上是 `Ctrl+Z` / `Ctrl+Y`，`Ctrl+Shift+Z` 是 macOS 绑定。

> **Warning**：重新启用插件不会让已打开的编辑器获得扩展（见 `obsidian-plugin-build.md`）。
> 套件开头必须无条件重载插件，并**新开编辑器**后再断言。

---

## 断言写法约定

| 约定 | 理由 |
|---|---|
| 断言**可观测结果**，不断言内部状态 | 例如断言落盘文本与 DOM 计数，而不是断言某个函数被调用 |
| 每条断言附上实际值 | 失败时无需复现即可定位 |
| 涉及写盘的检查前后比对**全文** | 数据安全是本项目的第一优先级 |
| 统计写入用适配器包装计数 | `app.vault.adapter.write` / `writeBinary`，跑完必须还原 |
| 区分"我们写的"与"宿主写的" | `.obsidian/workspace.json` 是 Obsidian 自己的布局持久化，不算违规 |
