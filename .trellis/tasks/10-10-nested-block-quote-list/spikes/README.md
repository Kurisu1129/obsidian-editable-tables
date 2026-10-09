# Spike 门禁的可运行载体

`spike-probe/` 是一次性探针插件，用来验 `implement.md` 阶段 0 的两个门禁。
源码存这里是为了**可复现** —— 它原本只活在 `spike-vault/.obsidian/plugins/` 下，
而那条路径被 `.gitignore` 覆盖，重建 vault 就丢了。

## 怎么再跑一次

```bash
cp -r .trellis/tasks/10-10-nested-block-quote-list/spikes/spike-probe \
      spike-vault/.obsidian/plugins/spike-probe
./scripts/restart-obsidian.sh
# 然后用 tools/cdp.mjs 驱动（配方见 ../research/spike-0-findings.md 末尾）
```

## 它暴露的钩子

在渲染进程里 `window.__spike` 上：

| 钩子 | 作用 |
|---|---|
| `view()` | 取当前活动 leaf 的 `EditorView`（**不要**用 `document.querySelector('.cm-editor')`，会抓到隐藏的后台 leaf） |
| `enableQuotes()` / `disableQuotes()` | 开关门禁 0.1 的引用块接管 |
| `enableIndent(px, prop)` / `disableIndent()` | 开关门禁 0.2 的行装饰；`prop` 收属性名（自动补 px）或整条声明串，例如 `'margin-left:40px !important'` |
| `scan()` | 打印扫到的引用块区间 |

## 注意

- 两个 compartment **默认开启**，否则新建编辑器会重置、让「切走再回来」这项产生假阴性。
- 改完 `main.js` 必须 `disablePlugin` + `enablePlugin`，并**新开一个 leaf** 才会生效。
- 这是**抛弃式**代码，不是产品代码。实际实现落地后应当删除。

## 目录里的其它东西

| 目录 | 内容 | 为什么存 |
|---|---|---|
| `fixtures/` | 两个门禁用的 fixture：`spike01.md`（引用块接管）、`spike02.md`（缩进行装饰）、`probe3.md` / `probe4.md`（研究阶段的对照与现状取证） | 原本在 `spike-vault/`，而 `spike-vault/*.md` 被 `.gitignore` 覆盖 —— 重建 vault 就丢了，门禁无法复现 |
| `shots/` | 被 `research/` 文档引用的截图 + 一份说明 | 同上，原本在被排除的 `.shots/` 下 |
| `research-probes/` | 研究阶段用过的 CDP 探针脚本 | 被 `research/` 文档引用，见其中 `README.md` |

**摆放回 vault**：把 `fixtures/*.md` 拷到 `spike-vault/` 根，`spike-probe/` 拷到
`spike-vault/.obsidian/plugins/`，即恢复成门禁当时的现场。
