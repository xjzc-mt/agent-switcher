# AgentSwitcher 0.1.0

2026-11-25 发布。本版起公开版本号归位至 `0.1.x` 系列（早期 `1.0.0`、`1.0.1` 测试包归档为预发布历史）。Mac 需要 macOS 13 或更高版本，Windows 支持 64 位（x64）。[0.1.0 下载与更新说明](https://github.com/xjzc-mt/agent-switcher/releases/tag/v0.1.0)

## 主要更新

- **一行命令快速安装。** 官网托管原生安装脚本：macOS 运行 `curl -fsSL https://xjzc-mt.github.io/agent-switcher/install.sh | bash` 自动识别 Apple Silicon / Intel、核对签名清单与 SHA-256 并安装至「应用程序」；Windows PowerShell 运行 `irm https://xjzc-mt.github.io/agent-switcher/install.ps1 | iex` 自动校验并静默安装。[应用内更新](app-updates.md)
- **一键安装更新并自动重启。** macOS（可写安装目录）与 Windows x64 均支持在「设置 → 应用与更新」验签下载新版，点击「立即安装并重启」后自动等待在途凭据写回、后台原子替换或静默覆盖安装并重新启动。[AGS-0012](../issues/archive/AGS-0012-seamless-in-app-update-install.md)
- **自动刷新间隔配置与失效账号分组。** 设置页支持分别配置当前账号（`1分 / 3分 / 5分 / 手动`）与备用账号（`5分 / 15分 / 30分 / 手动`）自动刷新间隔；凭据失效账号独立排入底部「凭据失效」组并标注原套餐，备用卡片同行高度对齐。[额度刷新](refresh-behavior.md)
- **macOS 菜单栏常驻展开。** 点击右上角菜单栏 AGS 图标直接展示当前账号额度与备用账号双列胶囊列表，无需二次悬停展开，支持键盘选择与同屏保持。[菜单说明](navigation-menus.md)
- **Codex 查询自愈与详情恢复指引。** 有效期内优先只读查额并自动对账中断的临时续期目录；精确区分网络/限流故障与真正的凭据失效，账号详情直接显示失败原因、恢复建议与「更新凭据」入口。[账号管理](account-management.md)
- **Windows Codex 桌面端与 Antigravity 支持。** 支持借用 Microsoft Store 版 Codex 首次运行准备的内置组件登录与查额度，切换时可确认关闭并按原方式重开 Codex 桌面；接入 Windows 受限令牌沙箱与 Antigravity 2.x 个人账号支持（需官方 `agy` CLI）。

## 从早期 1.0.x 测试版切换

由于版本号从早期测试版 `1.0.x` 回调至 `0.1.0`，已安装的 `1.0.0` / `1.0.1` 不会自动提示降号更新。请直接运行上方一行安装命令（或下载 `0.1.0` 安装包手动覆盖替换）完成本次切换，**原有账号池、加密凭据和偏好设置全部保留**。装上 `0.1.0` 后，后续 `0.1.1`+ 版本均可在应用内一键升级，且更新器会自动忽略已退役的历史 `1.0.x` 标签。

## 验证范围

- **三平台构建与启动**：Apple Silicon DMG、Intel DMG 与 Windows x64 Setup EXE 均通过 GitHub Actions 原生构建、安装与启动校验，并由离线 Ed25519 私钥签发 `.signed.json` 清单。Mac 应用采用 ad-hoc 签名（未经 Apple 公证），Windows 安装程序未进行 Authenticode 签名。
- **自动化与本机回归**：全套 TypeScript/脚本静态检查、Node 单元与集成测试、13 组 Electron 界面回归、官网构建及 `install.sh` 本地合成 DMG 安装替换验证全部通过。
- **待独立真机补验边界**：macOS 独立用户下两个真实 Antigravity 账号往返切换（[AGS-0001](../issues/AGS-0001-antigravity-file-auth.md)），以及 Windows 10/11 真机上商店版 Codex 与 Antigravity 真实账号往返切换和 NSIS 跨版自升级（[AGS-0008](../issues/AGS-0008-windows-runtime-and-sandbox.md)、[AGS-0009](../issues/AGS-0009-windows-codex-desktop-support.md)）仍待实机签收。
