# AGS-0018 · Windows PowerShell 5.1 安装脚本 BOM/中文乱码与共享代理 IP 触发 GitHub API 限流修复

- 状态：已关闭
- 发现日期：2026-11-25
- 关闭日期：2026-11-25
- 平台：Windows x64、macOS（Apple Silicon / Intel）
- 来源：local（用户 Windows 实机安装截图反馈）

## 1. 现象与复现

用户在 Windows PowerShell 5.1 执行 `irm https://xjzc-mt.github.io/agent-switcher/install.ps1 | iex` 时安装中断：
1. 第一行报 `The term 'ï»¿$ErrorActionPreference' is not recognized`，中文提示全部显示为单字节乱码；
2. 第 13 行请求 `https://api.github.com/repos/xjzc-mt/agent-switcher/releases/latest` 报 `API rate limit exceeded`（共享代理出口 IP 耗尽了未认证 REST API 的 60 次/小时配额），导致安装包未开始下载；
3. macOS 窄窗口终端通过 `curl ... | bash` 执行时，`curl --progress-bar` 因管道未拿到终端宽度按默认 79 列折行刷出多行 `#####`。

## 2. 根因与修复方案

### 根因定位
1. GitHub Pages 对 `.ps1` 不附带 `charset=utf-8`，Windows PowerShell 5.1 的 `Invoke-RestMethod` 按 ISO-8859-1 解码响应体，将文件头 UTF-8 BOM（`EF BB BF`）解析为 `ï»¿` 并破坏 UTF-8 中文；且 GitHub Release 附件 `.signed.json` 返回 `application/octet-stream` 时 `Invoke-RestMethod` 在 PS 5.1 不会自动反序列化 JSON。
2. [site/install.ps1](../../site/install.ps1) 与 [site/install.sh](../../site/install.sh) 默认查询 `api.github.com/.../releases/latest`，受每 IP 每小时 60 次未认证限流约束；而 `github.com/.../releases/latest` 的 `302` 跳转与 `releases/download/...` CDN 下载均不受 REST API 配额限制。

### 修复方案
1. **[site/install.ps1](../../site/install.ps1)**：
   - 改为无 BOM 纯 7-bit ASCII 源码并通过 `[regex]::Unescape` 输出 Unicode 中文，彻底免疫 PowerShell 5.1 `irm` 字符集误判；设置 `$ProgressPreference = 'SilentlyContinue'` 消除 PS 5.1 下载卡顿；
   - 改用 `[Net.HttpWebRequest]` 请求 `github.com/.../releases/latest` 跟随 `302` 跳转提取最新正式版标签，下载 `.signed.json` 后按 UTF-8 显式 `ConvertFrom-Json` 校验大小与 SHA-256，安装完成后输出 `%LOCALAPPDATA%\Programs\...` 实际落盘路径与快捷方式提示。
2. **[site/install.sh](../../site/install.sh)**：默认同样通过 `releases/latest` `302` 跳转解析正式版本号以避开共享代理 IP 下的 `api.github.com` 限流（保留 `AGS_RELEASE_API` 供本地离线测试注入），并通过 `/dev/tty` 读取真实终端列宽传入 `COLUMNS` 修复窄窗口进度条折行。
3. **[tests/site-build.test.cjs](../../tests/site-build.test.cjs)**：新增构建产物 `install.ps1` 无 BOM 纯 7-bit ASCII 字节级校验与无 `api.github.com` 依赖断言。

### 代码量基线与预估（物理行数）

| 类别 | 相关文件基线 | 预计新增 | 预计删除 | 预计净变化 |
| --- | --- | --- | --- | --- |
| 业务与官网 | `site/install.ps1` (75)、`site/install.sh` (160)，全仓 17,210 | +45 ~ +65 | -30 ~ -45 | +10 ~ +25 |
| 测试 | `tests/site-build.test.cjs` (192)，全仓 12,047 | +12 ~ +22 | 0 ~ -3 | +12 ~ +20 |
| 文档与问题单 | `issues/README.md` (59) 及本单，全仓 2,918 | +45 ~ +60 | -1 ~ -2 | +44 ~ +58 |

### 验收清单
- [x] `install.ps1` 构建产物不含任何 BOM、CR 或非 ASCII 字节，不访问 `api.github.com`，显式按 UTF-8 解析 `.signed.json` 并校验 SHA-256。
- [x] `install.sh` 默认通过 `releases/latest` 跳转获取正式版并适配窄终端宽度，`tests/site-build.test.cjs` 全部通过并部署至 GitHub Pages。

## 3. 修复记录

- 2026-11-25：完成 `site/install.ps1` 纯 ASCII 重写与 `302` 免限流获取版本、UTF-8 清单解析、安装路径回显；完成 `site/install.sh` 默认免 API 限流跳转与窄终端 `COLUMNS` 适配；补充 `tests/site-build.test.cjs` 字节级校验。
- 全仓同口径物理行数对账：业务与官网 17,210／+96／-54／+42／17,252，开发脚本 830／0／0／0／830，测试 12,047／+3／0／+3／12,050，文档与问题单 2,918／+50／-1／+49／2,967。业务净增略高于初估（+42 vs +25）是因为在 `install.sh` 切换默认 `302` 跳转模式的同时完整保留了 `AGS_RELEASE_API` 本地离线合成 DMG 测试分支。

## 4. 验收记录

- **验收日期与结论**：2026-11-25，**字节级无 BOM 纯 ASCII 校验、GitHub `302` 免 API 限流链路、本地回归与线上 Pages 产物核验全部通过，准予关闭归档**。
