# AgentSwitcher 0.1.1

2026-11-27 发布。支持 macOS 13+（Apple Silicon / Intel）与 Windows x64。已安装 `0.1.0` 的用户可直接在「设置 → 应用与更新」点击「检查更新 → 立即安装并重启」一键完成升级。[0.1.1 下载与更新说明](https://github.com/xjzc-mt/agent-switcher/releases/tag/v0.1.1)

## 主要更新

- **Antigravity 免 CLI 纯桌面账号管理。** macOS 与 Windows 用户仅安装官方 Antigravity 2.x 桌面客户端即可识别当前登录、保存账号、导入导出 `.ags` 加密备份并一键手动切换个人账号；需要查看模型组额度或独立浏览器登录时，安装官方 `agy` 1.5.9+ 并在主窗口点击「重新检测」即可免重启启用；兼容无邮箱个人 CLI 认证文件与长凭据双文件迁移。[AGS-0003](../issues/archive/AGS-0003-desktop-only-accounts.md) · [AGS-0001](../issues/archive/AGS-0001-antigravity-file-auth.md)
- **Windows 原生进程检测与 DPAPI 极速响应。** 移除高频路径上的 `powershell.exe` + WMI 进程查询与 PowerShell DPAPI 加解密调用，全部并入预编译原生辅助组件，只读额度查询统一跳过写密钥预检，消除系统睡眠唤醒后的 5 秒切换超时与主界面周期性冻结，并细化更高权限进程冲突、安全软件拦截等明确操作指引。[AGS-0021](../issues/AGS-0021-windows-native-process-and-dpapi-fastpath.md)
- **共享号池五层智能刷新与全端刷新统一。** 主窗口「刷新全部」、macOS 小菜单右上角刷新与 `Cmd+R` 统一刷新所看平台的当前账号与全部有效备用账号并逐项同步；移除卡片与单行表面的零散刷新图标（收归右键详情内刷新）；支持休眠/锁屏暂停与唤醒补查、打开面板前排 Top-4 优先保鲜、耗尽账号静默等待重置、外部共用活跃自适应与单号随机错峰。[额度刷新](refresh-behavior.md) · [AGS-0020](../issues/archive/AGS-0020-smart-quota-refresh-strategy.md)
- **macOS 菜单栏小菜单一致性与就地切换确认。** 主窗口与小菜单共享同一套单窗口额度色阶判定（不再因缓存时间或关闭主窗口而整屏变灰）；在副屏或当前屏点开小菜单切换账号时，退出重开客户端、保存当前登录与长凭据迁移确认均直接在小菜单面板内就地完成，不再跳回主窗口；`Cmd+W` 改为后台隐藏保活实现零延迟响应，并加高备用列表视口。[菜单说明](navigation-menus.md) · [AGS-0019](../issues/archive/AGS-0019-tray-state-consistency-and-interaction.md)
- **跨平台一键安装脚本加固与免下载发布签名。** `install.ps1` 与 `install.sh` 改走 `releases/latest` 跳转避开共享代理 IP 下的 GitHub REST API 限流，消除 Windows PowerShell 5.1 BOM/中文乱码及 macOS 窄窗口进度条折行；维护侧支持免下载远程元数据离线 Ed25519 秒签与一键发布。[AGS-0018](../issues/archive/AGS-0018-installer-rate-limit-and-ps51-encoding.md) · [AGS-0017](../issues/archive/AGS-0017-zero-download-release-signing.md)

## 升级方式

- **从 `0.1.0` 升级（推荐）**：打开 AgentSwitcher 前往「设置 → 应用与更新」，点击「检查更新」下载 `0.1.1` 后点击「立即安装并重启」，应用会自动安全收尾、完成替换并重开新版。
- **全新安装或从早期 `1.0.x` 测试包切换**：在 macOS 终端运行 `curl -fsSL https://xjzc-mt.github.io/agent-switcher/install.sh | bash`，或在 Windows PowerShell 运行 `irm https://xjzc-mt.github.io/agent-switcher/install.ps1 | iex`（也可直接下载 Release 附件覆盖安装），已有账号池与偏好设置完整保留。

## 验证范围

- **三平台构建与签名**：Apple Silicon DMG、Intel DMG 与 Windows x64 Setup EXE 均经 GitHub Actions 原生打包与安装自检，并通过离线 Ed25519 私钥签发 `.signed.json` 清单与 `SHA256SUMS`。Mac 应用采用 ad-hoc 签名（尚未接入 Apple 公证），Windows 安装程序未进行 Authenticode 签名。
- **自动化回归**：全套 TypeScript 与脚本语法检查、Node 单元与集成测试（含 Windows 标准用户受限令牌沙箱原生隔离验证）、Electron 界面回归及官网静态构建全部通过。
- **待独立真机终验项**：macOS 独立用户下两个真实 Antigravity 账号往返核验，以及 Windows 10/11 多账号睡眠唤醒真机下原生进程探测、商店版 Codex 与 Antigravity 真实账号往返及应用内跨版升级（[AGS-0008](../issues/AGS-0008-windows-runtime-and-sandbox.md)、[AGS-0009](../issues/AGS-0009-windows-codex-desktop-support.md)、[AGS-0021](../issues/AGS-0021-windows-native-process-and-dpapi-fastpath.md)）待装入 `0.1.1` 实机签收。
