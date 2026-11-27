# AGS-0003 · Antigravity 免 `agy` 纯桌面原生管理解耦与合规额度增强

- 状态：已关闭
- 记录日期：2026-11-23（2026-11-26 结合官方服务条款红线锁定两层架构方案；2026-11-27 在 [AGS-0019](AGS-0019-tray-state-consistency-and-interaction.md)、[AGS-0020](AGS-0020-smart-quota-refresh-strategy.md)、[AGS-0001](AGS-0001-antigravity-file-auth.md) 归档后刷新最新基线并结项）
- 平台：全平台（macOS Apple Silicon / Intel、Windows x64；Windows Codex 纯桌面内置 CLI 支持已拆入 [AGS-0009](../AGS-0009-windows-codex-desktop-support.md)）
- 来源：本地真机与 Windows 测试反馈

## 1. 现象与复现

1. **Antigravity 官方桌面包不包含 `agy` CLI**：
   - 实测 macOS `/Applications/Antigravity.app/Contents/Resources/bin/` 仅含 `language_server` 与 `agy-desktop-*`，Windows 官方桌面版同样未内置 `agy.exe`（与内置完整 `codex` CLI 的 Codex 桌面包不同）。
2. **未单独安装 `agy` CLI 的用户被拦在核心功能之外**：
   - Windows 上 [src/agents/antigravity.ts](../../src/agents/antigravity.ts) 第 `39` 行 `detectAntigravityRuntime()` 直接以 `resolveAntigravityCli()` 判断运行时，未装 `agy.exe` 时导入的账号连「保存当前登录」与「切换」按钮都被禁用；
   - macOS 上虽能识别 `Antigravity.app` 2.x，但额度刷新与独立登录报 `请先安装官方 Antigravity CLI（agy）`，用户不清楚原因与可选装法。

## 2. 根因与修复方案

### 合规边界与三条红线（必须严格遵守）
1. **严禁第三方代码直连服务接口或自行用 OAuth 令牌换票**：《Google Antigravity 附加服务条款》第 6 条明确规定使用第三方软件携带 Antigravity OAuth 访问服务属违约行为，可导致账号封禁。AGS **绝不**提取 `access_token / refresh_token` 自行请求远端额度/续期接口，也**绝不**逆向调用桌面内置私有 `language_server`。
2. **严禁随 AGS 安装包打包或私自分发专有 `agy` 二进制**。
3. **严禁无人值守自动轮换账号（Automated Account Rotation）绕过限额**（官方 FAQ 明确禁止）。

### 具体修复方案（两层渐进架构：纯桌面本地闭环 + 官方 `agy` 额度按需增强）
1. **第一层 · 免 `agy` 纯桌面本地管理完整闭环（[src/agents/antigravity.ts](../../src/agents/antigravity.ts)、[src/antigravity-native.ts](../../src/antigravity-native.ts)、[src/accounts.ts](../../src/accounts.ts)）**：
   - **纯桌面运行时检测（Windows + macOS 对齐）**：
     - Windows 下扩展 `detectAntigravityRuntime()`：除 `resolveAntigravityCli()` 外，检测官方桌面默认安装位置（`%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe`、`Google Antigravity`、`%ProgramFiles%` 等，读取 `resources/app/package.json` 版本或确认 `>= 2`）以及 Windows 凭据管理器 / `.gemini` 官方 2.x 原生凭据存在性，识别为 `'unified'`；
   - **拆开「原生凭据管理能力」与「在线额度/独立登录能力」（同时兼容未安装与旧版 `agy`）**：
     - `nativeEnabled` 只要平台为 `darwin | win32` 且 `runtime() === 'unified'` 即为 `true`（负责 Keychain / Windows 凭据管理器 / 双 `0600` 官方认证文件读写、同会话副本比对、切换事务与中断恢复），**不依赖 `resolveAntigravityCli()`**；
     - 新增按二进制文件指纹（`dev/ino/mtime`）缓存的官方 `agy` 版本核验（如要求支持 JSON `/usage`、`--settings` 与 `acp` `oauth-personal` 的 `>= 1.5.9` 版本，同时在 `antigravity-cli.ts` 补齐 `stderr` 未知参数/不支持子命令识别，避免因 `stderr: 'ignore'` 傻等 45 秒误报 `Antigravity 登录超时` 或笼统报 `查询失败`）；
     - `cliReady` 仅在 `agy` 存在且版本受支持时为 `true`：`management()` 在 `nativeEnabled` 下动态返回 `quota: cliReady`、`isolatedLogin: process.platform !== 'win32' && cliReady`、`storage: 'keychain'`、`canSaveCurrent: true`；
     - 将 [src/accounts.ts](../../src/accounts.ts) 中原本用 `management().quota` 守卫的本地多源凭据防冲突与版本比对（`syncCurrent` / `poolCopyOrder` / `useAccount` 第 `311`、`355`、`378`、`422`、`479` 行）、面板原生快照读取（`dashboard` 第 `1210` 行及 `main.ts` 第 `352` 行 `withDashboardNativeSnapshot`）改为检查独立的本地原生存储能力（如 `management.storage === 'keychain'` 或 `agent.sharedQuotaLogin`），确保**即使未装 `agy` 或本机 `agy` 版本过旧（`quota: false`），读取当前身份、保存当前登录、导入 `.ags` 备份、主窗口与小菜单手动一键切换及所有防丢保护 100% 正常工作**；同时保留该账号历史已有快照中的邮箱与套餐标签用于本地识别。
2. **第二层 · 无 `agy` / 旧版 `agy` 时的清爽纯凭据界面与精确引导（[src/agents/antigravity.ts](../../src/agents/antigravity.ts)、[src/antigravity-cli.ts](../../src/antigravity-cli.ts)、[src/main.ts](../../src/main.ts)、[renderer/app.js](../../renderer/app.js)、[renderer/accounts.css](../../renderer/accounts.css)）**：
   - 当 `nativeEnabled && !cliReady` 时：
     - 添加账号弹窗默认进入「本地登录（官方客户端登录）」：支持点击「打开 Antigravity 登录」拉起官方桌面客户端完成浏览器登录，返回 AGS 自动检测到新账号并一键「保存账号」（同时支持 Session 导入与备份导入）；
     - 主窗口与小菜单进入清爽的 `no-quota` 纯凭据切换布局，不报红字错误，所有正常保存/导入的个人账号均可直接点击「切换」；
     - 区分「未安装 `agy`」与「`agy` 版本过旧」给出精确轻量提示条：未安装时提供「查看官方安装说明」外链（`https://antigravity.google/docs/install`）；**检测到旧版本时直接明确提示 `本机 agy CLI 版本过旧（当前 vX.Y.Z），请运行 agy update 更新后查看额度`**，均附 **「重新检测」按钮**（装好或 `agy update` 后免重启即刻解锁额度与独立登录）。

### 边界约束（不做什么）
- 绝不新增任何直连 Google / Antigravity 远端服务的 HTTP/RPC 代码，绝不改动或弱化现有 Keychain / Windows 凭据管理器 / 受限令牌沙箱安全边界。
- 已安装 `agy` 的设备体验与现有完整模式保持 100% 一致，零退化。

### 代码量基线与预估（物理行数）

当前工作区最新全量基线（`AGS-0019`、`AGS-0020`、`AGS-0001` 完成后同口径物理行数）：业务源码 `17,686` 行、测试 `12,432` 行、开发脚本 `656` 行、文档 `3,157` 行。

| 类别 | 相关文件基线 | 预计新增 | 预计删除 | 预计净变化 |
| --- | --- | ---: | ---: | ---: |
| 业务源码 | `src/agents/antigravity.ts` (376)、`src/antigravity-native.ts` (1,030)、`src/antigravity-cli.ts` (328)、`src/accounts.ts` (1,621)、`src/main.ts` (725)、`renderer/app.js` (1,846)、`renderer/accounts.css` (934) | +95 ~ +155 | -25 ~ -45 | +65 ~ +115 |
| 测试 | `tests/antigravity-native.test.cjs` (1,215)、`tests/antigravity-cli.test.cjs` (458)、`tests/provider-management.test.cjs` (55)、`tests/ui-antigravity.cjs` (76) | +80 ~ +140 | -10 ~ -25 | +65 ~ +120 |
| 文档 | `docs/account-management.md` (341)、`docs/ui-design.md` (141)、本单与 `issues/README.md` | +20 ~ +40 | -10 ~ -25 | +10 ~ +20 |

### 验收清单
- [x] 在未安装 `agy` CLI 但装有 Antigravity 2.x 桌面的环境（macOS 与 Windows 模拟/单测覆盖）下：能正常识别当前桌面登录身份、支持拉起官方桌面登录后保存账号、支持导入 `.ags` 备份，且主窗口与小菜单均可正常点击「切换」完成凭据替换与桌面端重开。
- [x] 未安装 `agy` 时，`syncCurrent` 多源凭据冲突保护、同会话新令牌回写与切换中断恢复保护依然完整生效，不因 `quota: false` 被跳过。
- [x] 未安装 `agy` 或安装了过旧版本 `agy` 时界面不误报「登录超时 / 查询失败」，分别给出精确的安装或 `agy update` 升级提示及「重新检测」按钮；安装或升级为受支持版本后点击「重新检测」，免重启立即解锁额度展示、刷新与 macOS 独立登录。
- [x] 全程无任何第三方直连服务端请求代码，`npm run lint`、`npm test`、`npm run test:ui`、`npm run site:build` 全部通过，同步更新相关文档。

## 3. 修复记录

### 2026-11-27 · 纯桌面管理与官方 CLI 能力检测

- macOS 从桌面版本识别原生存储。Windows 还识别两个官方安装目录名、桌面版本资源、2.x 回退文件及系统凭据条目。明确识别为旧版桌面时优先沿用对应存储约束。
- 当前身份、本地登录保存、备份导入和手动切换走原生存储能力。凭据版本、多源冲突、桌面重开、切换中断恢复和待验证替换继续使用原事务。纯桌面模式保留归属匹配的邮箱和已知套餐。
- 官方 CLI 的版本按文件指纹缓存，最低支持 1.5.9。ACP 登录和额度命令遇到明确的不支持参数会提前结束。已提交续期却未确认写回时仍保留恢复证据。CLI 在登录中途降级后，可用桌面继续登录，已完成的独立授权仍可保存。
- 主窗口与 macOS 小菜单按能力展示额度和刷新。未安装时提供官方说明，过旧时显示版本与 `agy update`。点「重新检测」即可更新两个窗口。同步了账号管理、刷新、小菜单、界面约定、中英文 README 和网站支持说明。
- 切换账号由用户手动发起。额度和续期仍由用户自行安装的官方 CLI 执行。此次变更未添加直连服务接口、专有二进制或自动切换逻辑。

| 物理行数 | 开工基线 | 新增 | 删除 | 净变化 | 完成后 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 业务源码 | 17,686 | 254 | 76 | +178 | 17,864 |
| 测试 | 12,432 | 200 | 36 | +164 | 12,596 |
| 开发脚本 | 656 | 0 | 0 | 0 | 656 |
| 文档（按委托基线） | 3,157 | 42 | 11 | +31 | 3,188 |

新增主要来自 Windows 桌面与凭据条目识别、实际子进程的版本变更回归，以及两个平台的导入切换和登录降级验证。仅计开工工作副本至收口的差异。全仓 Markdown 开工实数为 3,228 行，收口为 3,259 行。

隔离自测覆盖了无 CLI 的 macOS 登录保存、备份还原、主窗口与小菜单切换、多源凭据变化时的重新确认，以及 Windows 模拟环境从 Mac 备份导入、切换和原地安装 CLI 后的查额与续期。使用合成账号、模拟安全存储和测试 CLI。Windows 真机与专用 macOS 钥匙串另行复验。

`npm run lint` 和 `npm run site:build` 通过。`npm test` 共 364 项，359 项通过，5 项因需要专用 macOS 用户或 Windows 原生环境跳过，0 项失败。`npm run test:ui` 的 13 组 Electron 测试全部通过。本机已从重建的源码启动预览，并确认主窗口可见。

## 4. 验收记录

### 2026-11-27 · 独立复核与结项归档

- **合规红线与安全边界核验通过**：
  - 全仓检索确认 `antigravity*`、`windows-*` 与 `renderer/` 零第三方服务端 HTTP/OAuth/RPC 请求、零私有 `language_server` 调用、零打包专有 `agy` 二进制，所有账号切换均由用户显式手动发起。
  - `BaseAgent.usesCredentialRevisions` 与 `sharedQuotaLogin` 将本地原生存储保护与在线查额能力彻底解耦：`quota: false`（未装或旧版 `agy`）时，`syncCurrent` 多源冲突拦截、`poolCopyOrder` 版本校验、`withDashboardNativeSnapshot` 快照读取、切换中断恢复以及历史邮箱/套餐标识保留均完整生效。
- **官方 CLI 版本核验与旧版快速阻断核验通过**：
  - `antigravityCliStatus` 按二进制文件 `[file, dev, ino, size, mtimeNs, ctimeNs]` 指纹缓存 `--version` 检测（`>= 1.5.9` 正式版为 `ready`），`watchUnsupportedSyntax` 以跨分块 96 字符滑窗识别未知参数/子命令并立即终止子进程（不回显原始 `stderr`，杜绝凭据泄露与 45 秒傻等误报超时）。
  - 主窗口与小菜单在无/旧版 `agy` 下进入清爽 `no-quota` 布局，未安装提供官方说明外链，过旧精确展示 `本机 agy CLI 版本过旧（当前 vX.Y.Z），请运行 agy update 更新后查看额度`，点击「重新检测」免重启即刻同步解锁双窗口额度与独立登录。
- **全量回归与物理行数独立对账（逐行一致）**：
  - 独立实跑 `npm run lint`、`npm test`（`359/364` 通过，`0` 失败，`5` 项按平台/专用钥匙串要求跳过）、`npm run test:ui`（`13/13` 组全绿）、`npm run site:build` 全部通过；
  - 物理行数独立复核：业务源码 `17,686 -> 17,864`（`+254 / -76`，净 `+178`）、测试 `12,432 -> 12,596`（`+200 / -36`，净 `+164`）、开发脚本 `656`（`0`）、文档（开工至提交验收）`3,157 -> 3,188`（`+42 / -11`，净 `+31`），与第 3 节记录完全一致。Windows 10/11 实机联验统一归口至活跃单 [AGS-0008](../AGS-0008-windows-runtime-and-sandbox.md) 与 [AGS-0009](../AGS-0009-windows-codex-desktop-support.md)，本单予以关闭归档。
