# 发布与提交 Obsidian 社区插件

本文件是维护者清单。代码已推送，`0.1.1` 的 GitHub Release 也已生成；剩下的是在 Obsidian 社区目录里提交。

## 当前状态

- 公开仓库：<https://github.com/Kurisu1129/obsidian-editable-tables>，`main` 已推送。
- `0.1.1` release 已发布，资产核对为 `main.js`、`manifest.json`、`styles.css`。
- `0.1.0` 也保留在 Releases 中；因描述以中文句号结尾不满足目录要求，提交使用 `0.1.1`。
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

## 离线安装包

给不便访问 GitHub Releases 的机器准备一个 zip：解压后把 `editable-tables/` 整个文件夹放进 `<库>/.obsidian/plugins/`。包内布局：

```
editable-tables-<version>.zip
├─ editable-tables/
│  ├─ main.js
│  ├─ manifest.json
│  └─ styles.css
└─ 安装说明.txt
```

本地构建后打包：

```powershell
$v = (Get-Content manifest.json -Raw | ConvertFrom-Json).version
$stage = Join-Path $env:TEMP "editable-tables-$v"
New-Item -ItemType Directory "$stage\editable-tables" -Force | Out-Null
Copy-Item main.js,manifest.json,styles.css "$stage\editable-tables"
Compress-Archive "$stage\*" "release\dist\editable-tables-$v.zip"
```

`release/dist/` 不进入 git；需要分发时把 zip 附到对应 GitHub release（`gh release upload <version> <zip>`）。

## 提交到 Obsidian 社区目录

官方流程已改为在 [community.obsidian.md](https://community.obsidian.md) 提交，**不再向 `obsidian-releases` 提 PR**。目录会读取仓库默认分支 HEAD 上的 `manifest.json`，并下载 tag 与 `version` 匹配的 release。

1. 用 Obsidian 账号登录 <https://community.obsidian.md>。
2. 在 **Profile → GitHub → Connect** 关联 GitHub 账号，目录据此确认仓库归属。
3. 左侧 **Plugins → New plugin**：填仓库 `https://github.com/Kurisu1129/obsidian-editable-tables`，Owner 选自己，确认同意 Developer policies 与持续维护承诺，提交。表单要填的值整理在 `release/directory-submission.json`。
4. 目录自动扫描 `manifest.json`、release 资产、源码，并校验构建产物与源码一致；错误项会阻止安装，按提示修正后递增版本重新发布，或让目录 **Request review** 立即重扫。
5. 发布后用户即可在 Obsidian 的「设置 → 第三方插件 → 浏览」中安装，之后新版本由 Obsidian 直接读取 tag 匹配的 release。

## 提交前自查

| 检查项 | 要求 | 当前值 |
|---|---|---|
| `id` 唯一且不含 `obsidian` | 目录全量唯一 | `editable-tables`，已核对未占用 |
| tag 格式 | 与 `manifest.json` 的 `version` 完全一致，无 `v` 前缀 | `0.1.1` = `0.1.1` |
| release 资产 | 必须包含 `main.js`、`manifest.json`、`styles.css` | 三者齐全 |
| `minAppVersion` | 与插件实际使用的最低 API 兼容 | `1.7.0` |
| 描述 | 250 字符以内、以英文句点 `.` 结尾、无 emoji、不以 "This is a plugin" 开头 | 中文，以 `.` 结尾 |
| 命令 ID | 不得包含插件 id | `copy-as-markdown` / `export-as-markdown` |
| LICENSE | 必须有 | MIT |
| 平台 | 使用桌面专属 API 时必须 `isDesktopOnly: true` | `true` |
| README | 说明功能、安装、已知边界、数据写入行为 | 已具备 |
| `fundingUrl` | 不接受赞助就不要写 | 未设置 |

## 审核可能关注的点

- 插件会写回笔记内容：README 已说明写回规则（优先 Markdown 管道语法，合并单元格才用 HTML），并说明只有用户实际编辑表格时才写盘。
- 打开 / 滚动 / 切换文件零写入（验收 AC9/AC19）。
- 引用块渲染使用 Obsidian 自己的 `MarkdownRenderer`，不注入远程资源、无网络请求、无遥测。
- 描述目前是中文但以英文句点结尾；如果自动审核要求英文描述，改成英文并递增版本重新发布即可。
