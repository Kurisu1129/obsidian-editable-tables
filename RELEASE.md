# 发布与提交 Obsidian 社区插件

本文件是维护者清单。代码已推送，`0.1.0` 的 GitHub Release 也已生成；剩下的是在 Obsidian 社区目录里提交。

## 当前状态

- 公开仓库：<https://github.com/Kurisu1129/obsidian-editable-tables>，`main` 已推送。
- `0.1.0` release 已发布，资产核对为 `main.js`、`manifest.json`、`styles.css`。
- 官方列表要求的文件已就位：`manifest.json`、`LICENSE`、`README.md`、`styles.css`；`versions.json` 保留作版本记录。
- `main.js` 是构建产物（`.gitignore` 已排除），由 `.github/workflows/release.yml` 在打 tag 时构建并附到 release。
- GitHub CLI 已登录 `Kurisu1129`，token 具备 `repo` + `workflow` 权限。
- `editable-tables` 这个 id 已核对，未出现在社区目录现有条目中。

## 发布新版本

1. 更新 `manifest.json` 的 `version`（semver，`x.y.z`）；同步 `package.json` 与 `versions.json`。
2. 提交并推送 `main`。
3. 打与版本号**完全相同**的 tag（不要 `v` 前缀），推送：

```bash
git tag -a 0.2.0 -m "0.2.0"
git push origin 0.2.0
```

workflow 会跑测试、构建、校验 tag 与 manifest 版本一致，然后创建 release 并附上三个文件。

## 提交到 Obsidian 社区目录

官方流程已改为在 [community.obsidian.md](https://community.obsidian.md) 提交，**不再向 `obsidian-releases` 提 PR**。目录会读取仓库默认分支 HEAD 上的 `manifest.json`，并下载 tag 与 `version` 匹配的 release。

1. 用 Obsidian 账号登录 <https://community.obsidian.md>。
2. 在个人资料里关联 GitHub 账号（用来说明你是该仓库的所有者）。
3. 添加插件，填入仓库 `Kurisu1129/obsidian-editable-tables`。目录会读取 `manifest.json` 的 id / name / description / author / isDesktopOnly；表单要填的值也整理在 `release/directory-submission.json`。
4. 提交后由自动审核给出需要修正的项；修正后递增版本、重新发 release，再重新提交。
5. 审核通过并发布后，用户即可在 Obsidian 的「设置 → 第三方插件 → 浏览」中安装。

## 提交前自查

| 检查项 | 要求 | 当前值 |
|---|---|---|
| `id` 唯一且不含 `obsidian` | 目录全量唯一 | `editable-tables`，已核对未占用 |
| tag 格式 | 与 `manifest.json` 的 `version` 完全一致，无 `v` 前缀 | `0.1.0` = `0.1.0` |
| release 资产 | 必须包含 `main.js`、`manifest.json`、`styles.css` | 三者齐全 |
| `minAppVersion` | 与插件实际使用的最低 API 兼容 | `1.7.0` |
| 描述 | 250 字符以内、以句号结尾、无 emoji、不以 "This is a plugin" 开头 | 中文，以「。」结尾 |
| 命令 ID | 不得包含插件 id | `copy-as-markdown` / `export-as-markdown` |
| LICENSE | 必须有 | MIT |
| 平台 | 使用桌面专属 API 时必须 `isDesktopOnly: true` | `true` |
| README | 说明功能、安装、已知边界、数据写入行为 | 已具备 |
| `fundingUrl` | 不接受赞助就不要写 | 未设置 |

## 审核可能关注的点

- 插件会写回笔记内容：README 已说明写回规则（优先 Markdown 管道语法，合并单元格才用 HTML），并说明只有用户实际编辑表格时才写盘。
- 打开 / 滚动 / 切换文件零写入（验收 AC9/AC19）。
- 引用块渲染使用 Obsidian 自己的 `MarkdownRenderer`，不注入远程资源、无网络请求、无遥测。
- 描述目前是中文；如果自动审核要求英文或要求以 `.` 结尾，改成英文描述并递增版本重新发布即可。
