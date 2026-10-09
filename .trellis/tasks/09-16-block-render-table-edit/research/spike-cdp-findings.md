# Spike 实测结果（CDP，真实 Obsidian 运行时）

> 方法：`--remote-debugging-port=9222` + 自写 CDP 客户端（node 内置 WebSocket，零依赖），
> 在 `F:\workplace\obsidian-md-formatter\spike-vault` 这个**全新测试 vault** 上实测。
> 用户真实 vault 未受任何影响。

## 环境事实

| 项 | 值 |
|---|---|
| Obsidian 可执行文件 | `D:\obsidian\Obsidian.exe` |
| 运行时 Electron / Chrome | Electron 39.8.3 / Chrome 142 |
| UA 报告版本 | `obsidian/1.12.7`（注：userData 下的 asar 文件名为 `obsidian-1.13.7.asar`，两者不一致，未深究） |
| 全部 CDP target | 1 个 page（`app://obsidian.md/index.html`）+ 2 个 worker |
| 新建 vault 的 `livePreview` 默认值 | **true** |

## 实测结论

### 1. 列表项下的嵌套表格 —— **彻底空白**（确认 F4）

`nested.md` 中缩进 4 空格的表格，在 Live Preview 下：

```
tableWidgets = 0
tables       = 0
逐行 DOM 文本：
  5:     | 姓名 | 年龄 |
  6:     |------|------|
  7:     | 张三 | 28 |
```

→ **原生完全不渲染**，就是裸管道源码。用户的头号痛点被直接观测确认。

### 2. 顶层表格 —— 渲染正常，且是块级 widget

`top-level.md` 中：

```
tableWidgets        = 1
widgetClass         = "cm-embed-block cm-table-widget markdown-rendered"
tables              = 1
cellCount (td/th)   = 9
isContentEditable   = false
contenteditableCount= 0
inputCount          = 0
```

→ 渲染为一个 `cm-table-widget` 块级 widget，内含真实 `<table>`。**单元格不是 contenteditable**，也没有 input。
光标移入表格时，仅当前行还原为源码（`cmLines` 3 → 4，widget 数不变）。

### 3. 🔥 Obsidian 内置了完整的表格结构命令

从 `app.commands.commands` 中枚举出：

```
editor:insert-table
editor:table-row-before / -after / -up / -down / -copy / -delete
editor:table-col-before / -after / -left / -right / -copy / -delete
editor:table-col-align-left / -center / -right
```

**实测 `editor:table-row-after` 在顶层表格上生效**，且自动重排对齐：

```
执行前：
| 姓名 | 年龄 | 城市 |
|------|------|------|
| 张三 | 28 | 北京 |

执行后：
| 姓名  | 年龄  | 城市  |
| --- | --- | --- |
|     |     |     |      ← 新插入
| 张三  | 28  | 北京  |
```

→ **增删行列、移动行列、列对齐这些能力 Obsidian 全部已有。缺的不是能力，是可见的 UI。**

### 4. 原生命令在嵌套表格上 **完全不生效**

光标置于嵌套表格行内，执行同一命令：

```
executeCommandById('editor:table-row-after') => false
文档：零变化
```

→ 嵌套场景在**渲染层与命令层双重真空**。

## 汇总

| 场景 | 渲染 | 原生命令 | 缺口性质 |
|---|---|---|---|
| **顶层表格** | ✅ block widget | ✅ 全部生效 | **只是缺可见 UI** |
| **嵌套表格** | ❌ 裸源码 | ❌ 返回 false | **彻底空白** |

## 对设计的影响

1. **D5 的前提被修正**：先前判断「顶层表格什么都不能、编辑仍需回源码」**是错的**。顶层表格渲染正常、结构命令齐全、命令还会自动重排对齐。接管顶层等于**重造一个基本能用的东西**，还要与原生渲染器争抢装饰优先级 —— 性价比大幅下降。
2. **出现一条更便宜且零装饰冲突的路径**：顶层表格不抢装饰，只挂一个工具栏调用 `editor:table-*` 原生命令。
3. **新的冲突**：该路径产出的仍是**管道表格**，与 **D3（所有表格统一落盘为 HTML）** 直接矛盾。若坚持 D3，顶层表格就不能走原生命令路径，必须回到自建 widget + 装饰争抢。

## 仍未验证

- **装饰优先级**：插件的 `Decoration.replace` 能否压过原生表格渲染器。需真正打包一个插件才能测。
- **单元格能否原地输入**：`isContentEditable=false` 且无 input，但 asar 中该 widget 类含 `placeCursorInCell` / `getNextCell` / `deselectCells` 等方法，交互模型尚未实测（合成事件未能触发原生处理器）。

## 决策记录（实测之后）

用户在被呈现两条路径后，**明确选择维持 D3（所有表格统一落盘为 HTML）+ D5（顶层 + 嵌套全场景接管）**，即选项 B：

- 接受「主动替换 Obsidian 工作正常的原生表格实现」，属**主动降级换统一**，而非填补空白。
- 装饰优先级 spike 因此从「可选回退」**升级为必经门禁（AC10）**。
- 若 spike 失败 → D3 + D5 组合不可达，须回到用户重新决策。
- Out of Scope 新增：复用原生 `editor:table-*` 命令（统一 HTML 后该路径不可用）。

## 〔门禁〕AC10 实测结果：**通过**

用 `Prec.highest(tableField)` 注册扩展后，在 `top-level.md` 上实测：

| 时机 | `.mdft-table`（我方） | `.cm-table-widget`（原生） |
|---|---|---|
| 初次打开文件 | 1 | **0** |
| 表格外围编辑后 | 1 | **0** |
| 撤销外围编辑后 | 1 | **0** |
| 切到 nested.md | 1（cells=4） | **0** |
| 切回 top-level.md | 1 | **0** |

→ `Prec.highest` **确实能稳定压过** Obsidian 原生表格渲染器。D5 的全场景接管路线成立。
→ 附带确认 **AC2**：Obsidian 拒绝渲染的嵌套表格，我方 widget 正常渲染（`nested.md` cells=4）。

## 达成原生视觉对齐的做法（AC4）

**不要手写表格 CSS。** Obsidian 的原生表格样式来自 `.markdown-rendered table|td|th` 这一组规则，由官方 `--table-*` 变量驱动：

```css
.markdown-rendered table { border-collapse: collapse; line-height: var(--table-line-height); }
.markdown-rendered td, .markdown-rendered th {
  padding: var(--size-2-2) var(--size-4-2);
  border: var(--table-border-width) solid var(--table-border-color);
  min-width: var(--table-column-min-width);
  vertical-align: var(--table-cell-vertical-alignment);
}
.markdown-rendered th { font-size: var(--table-header-size); font-weight: var(--table-header-weight); ... }
```

给 widget 根节点加 `markdown-rendered` 类即可全部继承。

**实测对齐结果**（原生 vs 我方，运行时计算样式）：

| 指标 | 原生 | 我方 |
|---|---|---|
| table 宽度 | 178px | **178px** |
| 行高 | 30,30,30,30 | **30,30,30,30** |
| `line-height` | 20.8px | **20.8px** |
| th `padding` | 0px（内层 wrapper 承担 4px 8px） | 同 |
| th `border-top` | 0.8px solid rgb(51,51,51) | **同** |
| th `font-weight` | 600 | 600 |
| th `min-width` | 59.2031px | **59.2031px** |
| td `min-width` | 56.2969px | **56.2969px** |

→ **逐像素一致**。空单元格需内嵌 `<br>` 才能保持行高（原生同样如此）。

## 其他实测细节

- 原生单元格内还带 `.table-row-drag-handle` / `.table-col-drag-handle`（grip 图标）—— 即原生**已有行列拖拽手柄**。
- 原生表格结构：`div.cm-table-widget.markdown-rendered > div.table-wrapper > table.table-editor > tr > td[dir=auto] > div.table-cell-wrapper`
- `td` 带 `dir="auto"`，`th` 带 `dir="ltr"`

## 复现方式

```bash
# 关闭 Obsidian 后
cmd /c start "" "D:\obsidian\Obsidian.exe" --remote-debugging-port=9222
curl http://127.0.0.1:9222/json/list
node cdp.mjs -f <expr.js>     # 见 %TEMP%\cdp.mjs
```
