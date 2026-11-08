# 发布与提交 Obsidian 社区插件

本文件是维护者清单。代码提交已经完成；下面是从"本地仓库"走到"Obsidian 社区插件市场"的步骤。

## 当前状态

- 仓库还没有配置 GitHub remote（`git remote -v` 为空）。
- 官方列表要求的文件已就位：`manifest.json`、`versions.json`、`LICENSE`、`README.md`、`styles.css`。
- `main.js` 是构建产物（`.gitignore` 已排除），由 `.github/workflows/release.yml` 在打 tag 时构建并附到 release。
- 本机没有 `gh` CLI，也没有凭证助手；创建远程仓库/推送需要你提供仓库地址与 GitHub 登录。

## 1. 创建公开仓库并推送

在 GitHub 创建 **public** 仓库（建议名 `obsidian-editable-tables`），然后：

```bash
git remote add origin git@github.com:<owner>/obsidian-editable-tables.git
git push -u origin main
```

把 `release/community-plugins-entry.json` 里的 `repo` 改成实际的 `<owner>/<repo>`。

## 2. 发布一个 release

Obsidian 要求：

- **tag 与 `manifest.json` 的 `version` 完全一致**（`0.1.0`，不要加 `v` 前缀）；
- release 里必须包含 `main.js`、`manifest.json`、`styles.css`。

```bash
git tag -a 0.1.0 -m "0.1.0"
git push origin 0.1.0
```

`.github/workflows/release.yml` 会跑测试、构建，校验 tag 与 manifest 版本一致，然后创建 release 并附上三个文件。

发布新版本时同步更新：

1. `manifest.json` 的 `version`
2. `versions.json` 增加 `"<新版本>": "<minAppVersion>"`
3. `package.json` 的 `version`（可选，但与 manifest 保持一致更清晰）

## 3. 提交到官方社区列表

1. Fork [`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases)。
2. 在 `community-plugins.json` 数组中加入 `release/community-plugins-entry.json` 的内容（把 `repo` 换成实际地址）。按仓库现有惯例放到数组末尾；如果文件按 `id` 排序，则插入到对应位置。
3. 提交 PR，标题建议：`Add plugin: Editable Tables`。
4. 等待 Obsidian 团队审核（通常几天）。合并后插件会出现在「设置 → 第三方插件 → 浏览」中。

条目格式（与 `release/community-plugins-entry.json` 一致）：

```json
{
  "id": "editable-tables",
  "name": "Editable Tables",
  "author": "evans",
  "description": "把 Live Preview 中的表格渲染为可编辑网格：支持列表项内嵌表格、单元格原地编辑、增删行列、合并拆分单元格；引用块整段渲染，列表项内嵌的块与父项正文对齐。",
  "repo": "evans/obsidian-editable-tables"
}
```

## 提交前自查

| 检查项 | 要求 |
|---|---|
| `id` 唯一 | `editable-tables` 不能与 `community-plugins.json` 中已有的 `id` 重复。提交前在文件里搜一遍；本机无网络时无法自动核对。 |
| tag 格式 | 与 `manifest.json` 的 `version` 完全一致，无 `v` 前缀。 |
| release 资产 | 必须包含 `main.js`、`manifest.json`、`styles.css`。 |
| `minAppVersion` | 当前 `1.7.0`，需与 `versions.json` 一致。 |
| 许可 | `LICENSE` 已存在（MIT）。 |
| 平台 | `isDesktopOnly: true`，因为插件依赖桌面端编辑器的 DOM/鼠标行为。 |
| 描述 | 与 `manifest.json` 的 `description` 一致，不含 emoji、不以 "This plugin" 开头。 |
| README | 已包含功能、安装、已知边界与验证方式。 |

## 审核可能关注的点

- 插件会写回笔记内容：README 与 `manifest.json` 已说明写回规则（优先 Markdown 管道语法，合并单元格才用 HTML）。
- 只在用户实际编辑表格时写盘；打开/滚动/切换文件零写入（验收 AC9/AC19）。
- 引用块渲染使用 Obsidian 自己的 `MarkdownRenderer`，不注入远程资源。
