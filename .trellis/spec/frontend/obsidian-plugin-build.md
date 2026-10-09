# Obsidian 插件构建与打包约定

## Scenario: 打包一个注入编辑器扩展的 Obsidian 插件

### 1. Scope / Trigger

- **Trigger**：新增依赖、调整 `esbuild.config.mjs`、升级 Obsidian 或 CodeMirror 版本。
- 违反以下任一条都会导致**静默失效** —— 不报错，只是"插件像没生效"。

### 2. Signatures

```jsonc
// package.json —— 版本必须与 obsidian 包的 peerDependencies 精确一致
"devDependencies": {
  "@codemirror/state": "6.5.0",
  "@codemirror/view": "6.38.6",
  "obsidian": "1.13.1"
}
```

```js
// esbuild.config.mjs
const cmExternals = [
  '@codemirror/autocomplete', '@codemirror/collab', '@codemirror/commands',
  '@codemirror/language', '@codemirror/lint', '@codemirror/search',
  '@codemirror/state', '@codemirror/view',
  '@lezer/common', '@lezer/highlight', '@lezer/lr',
];
external: ['obsidian', 'electron', ...cmExternals]
```

### 3. Contracts

| 项 | 约定 |
|---|---|
| CodeMirror 包 | **必须全部 external**。Obsidian 自带唯一一份 CM6 实例。 |
| 版本对齐 | 与 `npm view obsidian peerDependencies` 给出的版本**精确一致**（它用的是精确锁定，不是范围）。 |
| 格式 | `cjs`，`target: es2018`，入口 `src/main.ts`，产物 `main.js`。 |
| 移动端 | 依赖编辑器内部 API 时置 `isDesktopOnly: true`。 |

### 4. Validation & Error Matrix

| 条件 | 后果 |
|---|---|
| 把 `@codemirror/state` 打进 bundle | 得到**第二个模块实例**，`Decoration` / `StateField` 的类标识不同 → 宿主编辑器**静默忽略**你的装饰。不报错。 |
| 版本与 peerDependencies 不一致 | `npm install` 直接 ERESOLVE 失败；强装则类型与运行时行为可能对不上。 |
| 依赖 CM5 API | 随 CM6 迁移必然失效（社区已有插件因此报废）。 |

### 5. Good / Base / Bad Cases

- **Good**：CM6 全家 external；版本锁定到宿主声明值；只用 `registerEditorExtension` 等公开接口。
- **Base**：手写 `main.js` 不经打包 —— 仅限一次性实验。
- **Bad**：`import { Decoration } from '@codemirror/view'` 且未 external。

### 6. Tests Required

- 构建后检查 bundle 内**不含** CM6 实现：`grep -c require\( main.js` 应只有少量外部引用。
- 装载后断言 widget 真的出现（`.mdft-table` 计数 ≥ 1），而不是假定代码跑过了。

### 7. Wrong vs Correct

#### Wrong

```js
// 未 external —— bundle 里塞进了第二份 CodeMirror
external: ['obsidian', 'electron']
```

#### Correct

```js
// 全部 CM6 包 external，宿主提供唯一实例
external: ['obsidian', 'electron', ...cmExternals, ...builtins]
```

---

## 插件生命周期约定

> **Warning**：`Plugin.registerEditorExtension` 只对**之后创建**的编辑器生效。
> 重新加载插件后，已经打开的标签页不会获得扩展。验证时必须新开标签页或重启应用。

> **Warning**：`app.plugins.enablePlugin(id)` **不持久化**。
> 自动化脚本用它启用插件后，一旦应用重启插件就没了，后续断言会产生**假阴性**。
> 要持久化必须写入 `<vault>/.obsidian/community-plugins.json`（或使用 `enablePluginAndSave`）。

> **Warning**：插件设置用 `loadData` / `saveData`，不要写进 vault 的普通文件 —— 那样会污染用户笔记目录。
