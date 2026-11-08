# Spike 0 结论：两个门禁均通过

- **Date**: 2026-10-10
- **环境**: Obsidian（`Platform.version` 1.13.7）、Windows 11、vault = `spike-vault`、Live Preview
- **手法**: 一次性探针插件 `spike-vault/.obsidian/plugins/spike-probe/`（**非产品代码**，测完已停用），
  通过 CDP 驱动；CM6 模块走 `require('@codemirror/*')` 以复用 Obsidian 自己的类实例
- **结论**: **0.1 与 0.2 全部通过**，D9 门禁不作废，可按 `design.md` 实施

---

## Spike 0.1 引用块能否被自己的装饰接管〔**通过**〕

**做法**：`Decoration.replace({ block: true, widget })` 覆盖一个连续引用块区间 + 区间外 `MarkdownRenderer.render` 渲染源码。**不加 `Prec.highest`。**

fixture `spike01.md`：引用块内含标题、管道表格、围栏代码块、列表；另设一个**顶层表格作对照组**。

| 观测项 | BEFORE | AFTER |
|---|---|---|
| 我方引用块 widget | 0 | **1** |
| 字面围栏行 | 2 | **0** |
| 字面管道行 | 3 | **0** |
| 字面标题行 `> ##` | 1 | **0** |
| 字面列表行 `> - ` | 2 | **0** |
| widget 内 `blockquote` / `h2` / `table` / `pre` / `ul` | — | **1 / 1 / 1 / 1 / 1** |
| 对照组：本插件表格 widget | 1 | **1**（未受影响） |
| 对照组：原生 `cm-table-widget` | 0 | **0** |

**三种时机稳定性**（初次打开 / 编辑外围文本后 / 切走再回来）：widget 计数恒为 **1**，对照组表格全程为 1。

**结论**：
1. **不需要 `Prec.highest`** —— 与 `design.md` §1.2 的推断一致（纯引用块没有原生 widget 去争区间）。
2. `MarkdownRenderer` 一次覆盖**标题 / 表格 / 代码块 / 列表**全部块类型，无需自建渲染。
3. 接管引用块**不影响**既有的表格接管。
4. 截图：**当时未落盘**（AFTER 态那张漏拍了）。本门禁的证据是上表的断言数字，
   截图只是旁证，不影响结论成立。同一 fixture 的 BEFORE 态见 `../spikes/shots/probe4.png`
   （引用块内的表格/标题/列表已退化成字面源码）—— 两张合起来才构成对照，
   下次重跑 0.1 时顺手补拍。详见 `../spikes/shots/README.md`。

---

## Spike 0.2 行装饰能否给原生代码块补缩进〔**通过，但只有一种写法可行**〕

fixture `spike02.md`：列表项内的一级 / 二级代码块 + **顶层代码块作对照组**。

**基线**（CSS px，字形左边缘）：父项一级正文 **400**、父项二级正文 **409**；一级代码块内容 **392**（外凸 8px）、二级 **409**；代码块背景盒恒为 **376**（整行宽）。顶层代码块内容 392、背景盒 376。

### 四种写法的实测对比（位移 40px）

| 写法 | 文字 x | 背景盒 x | 判断 |
|---|---|---|---|
| `padding-left: 40px` | 432 ✓ | **376 ✗** | **不足** —— 只推动文字，背景盒仍压在项目符号左侧，从属关系没建立 |
| **`margin-left: 40px !important`** | 432 ✓ | **416 ✓** | **可行** —— 参与布局，盒子整体右移；宽度收窄，右侧不溢出 |
| `position: relative; left: 40px` | 432 ✓ | 416 ✓ | 不可取 —— 纯视觉位移，盒子实际仍占 376→980 却绘制在 416→1020，**右侧溢出 40px**，会被 `contain: paint` 裁 |
| `transform: translateX(40px)` | 432 ✓ | 416 ✓ | 不可取 —— 同上溢出；且 `transform` 会影响 `getBoundingClientRect`，可能扰乱 CM6 的坐标测量 |

顶层对照组在四种写法下**均未被改动**（内容 392、盒 376）。

### 为什么非要 `!important`

实测：inline `style="margin-left: 40px"` **确实写进了元素**（`getAttribute('style')` 可见），
但 `getComputedStyle().marginLeft` 恒为 **0px**，且常规 `document.styleSheets` 扫描找不到命中的规则。

→ **宿主把 `margin: 0` 写在级联层（`@layer`）里并带 `!important`**。
按 CSS 级联规则，层内的 author `!important` 会压过**非 important 的 inline 样式**；加上 `!important` 后 inline 才胜出。

> ⚠️ **这与 `codemirror-widgets.md` 里「不要用 `!important` 对抗宿主」的告诫有张力，必须区别对待**：
> 那条告诫针对的是 `contain: paint` —— 它是宿主的**刻意安全保证**（防 widget 内容串到相邻行），对抗它会让 bug 复现。
> 这里的 `margin` 只是宿主的**默认视觉样式**，不承载任何安全语义；覆盖它是修正渲染缺口，不是拆安全网。
> 但仍应视为**有意的、范围极窄的例外**：只在「嵌在列表项内的代码块行」上使用，不得推广成通用手法。

### 稳定性（4/4 通过，无漂移）

| 时机 | 文字 x | 背景盒 x | 实际 `margin-left` |
|---|---|---|---|
| 启用后 | 432 | 416 | 40px |
| 编辑文档后 | 432 | 416 | 40px |
| **切走再回来** | 432 | 416 | 40px |
| 连续重设 3 次后 | 432 | 416 | 40px |

**原生能力未受损**：语法高亮保留、语言标签（`.code-block-flair`，JavaScript/Python/JavaScript 三个齐全）、折叠指示器 9 个不变。

**退化行为可接受**：若 Obsidian 未来改掉这层 CSS，缩进会**静默失效**（回到外凸），
不会报错、不会损坏文档 —— 失败模式是「没效果」，不是「坏掉」。

- 截图：`../spikes/shots/spike02-none.png`（基线）、`../spikes/shots/spike02-pad.png`（padding，盒子没动）、`../spikes/shots/spike02-margin.png`（margin，盒子对齐）

---

## 复现手法与踩到的坑

探针插件的**源码已存档**在 `../spikes/spike-probe/`（原本只在被 gitignore 的
`spike-vault/.obsidian/plugins/` 下，会随 vault 重建丢失）。重新部署与钩子说明见
`../spikes/README.md`。

```bash
# 部署探针后，用 CDP 驱动
node tools/cdp.mjs -f <expr.js>       # 建议写文件用 -f，避免模板字符串转义打架
```

1. **多个 `.cm-editor` 实例**：`document.querySelector('.cm-editor')` 会抓到**隐藏的后台 leaf**，
   其文档与当前编辑的不是同一个（症状：读到的行数与内容对不上）。
   可靠入口是 `app.workspace.activeEditor.editor.cm`；DOM 兜底要用 `.workspace-leaf.mod-active .cm-editor`。
2. **`Compartment` 的默认值决定新编辑器**：`registerEditorExtension` 只对**之后创建**的编辑器生效（F21 的延续）。
   spike 里用 `compartment.of([])` 做默认，导致「切走再回来」时装饰消失 —— 这是**探针的人为因素，不是真实结论**。
   改成默认开启后该项即通过。产品代码里扩展是全局注册的，不存在此问题。
3. **重建编辑器才能加载改过的探针代码**：改完 `main.js` 必须 `disablePlugin` + `enablePlugin`，
   并**新开一个 leaf**（`app.workspace.getLeaf('tab')`）才能拿到新注册的扩展。
4. **表达式里避免转义地狱**：`\n`、反引号在 bash heredoc → JS 模板字符串 → CDP 表达式三层里会被反复转义。
   写成独立 `.js` 文件用 `-f` 读入最省事。

---

## 对设计的影响

- `design.md` §2.4 的 D9 门禁**解除**，缩进量实现确定为：**`margin-left: <N>px !important` 的行装饰**。
- `design.md` §7 的未决项 1（D9）可关闭。剩 2、3 项（引用块边界穷举、内链点击）仍待实施期确认。
- `implement.md` 阶段 0.2 的结论分支走「✅ 稳定生效」。
- **新增约束**（写进 `design.md`）：`!important` 只允许出现在「列表内代码块行」这一处，
  且必须在代码注释里写明理由与上文那条张力，避免后来者照抄成通用手法。
