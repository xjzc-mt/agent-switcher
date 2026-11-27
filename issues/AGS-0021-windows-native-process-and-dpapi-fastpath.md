# AGS-0021 · Windows 进程探测与密钥校验去 PowerShell/WMI 原生化、主线程防卡顿及报错指引明确化

- 状态：待验收
- 日期：2026-11-27
- 平台：Windows（主修复，同时覆盖 Codex 与 Antigravity）+ macOS（异常兜底对齐）
- 来源：`v0.1.0` Windows x64 真机故障报告与截图反馈（关联 [AGS-0008](AGS-0008-windows-runtime-and-sandbox.md)、[AGS-0009](AGS-0009-windows-codex-desktop-support.md)）

## 1. 现象与复现

在一台长期运行并经历睡眠唤醒的 Windows x64 设备上使用 `AgentSwitcher 0.1.0` 管理 6+ 个 Codex 账号时出现以下问题，重启系统后恢复：

1. **手动切换账号连续 9 次卡在 `5.06s ~ 5.11s` 失败并弹窗阻断**：
   - 脱敏故障报告中 `id: 15~18, 20, 21, 23, 24, 47` 共 9 次手动 `switch` 全部在 `5061ms ~ 5108ms` 返回 `result: "failed"`，且诊断步骤为空（`steps: []`）。
   - 界面弹出笼统提示：`无法确认 Windows 当前用户的客户端或 CLI 运行状态，请稍后重试`，用户无法判断是杀软拦截、权限冲突还是系统服务卡顿，连续盲点重试均无效。
2. **当前账号每分钟自动刷新固定先超时 5s，且每轮刷新伴随 `4s ~ 16.5s` 的主线程同步阻塞**：
   - 25 次当前账号自动刷新（`id: 1~14, 19, 22, 25, 34~41, 43, 46`）均在 `5306ms ~ 5737ms` 记录 `process-unknown` 并降级为 `read-only`；未超时的 `id: 27` 仅进程探测一步就耗时 `16,435ms`。
   - 紧随 `read-only` 之后（及所有备用账号 `id: 28~32, 42` 的 `access-valid` 之前），每轮刷新还存在 **`3.2s ~ 8.7s`** 的同步阻塞窗口；其中 `id: 39` 在 `22,074ms`（`read-only` 后 `16,587ms`）触发 `15s` 超时，记录 `storage-unavailable` 并导致刷新失败。

## 2. 根因与修复方案

### 举一反三全链路根因分析

排查全仓所有外部子进程调用（`powershell.exe`、`Get-CimInstance`、`execFileSync`、`osascript`、`/bin/ps`）后，确认 Windows 下 Codex 与 Antigravity 共用以下同源瓶颈，且部分错误分支存在诊断漏记与提示模糊问题：

1. **【P0 · 切换阻断元凶】高频进程枚举依赖冷启动 `powershell.exe` + 多轮 WMI（`Winmgmt` / `WmiPrvSE.exe`）RPC**：
   - [windows-processes.ts](../src/windows-processes.ts) 的 `userProcesses()`（被 Codex 与 Antigravity 的切换、桌面检测、重启客户端及每分钟当前账号刷新共用）每次冷启动 `powershell.exe`，加载 .NET CLR、AMSI 与 `CimCmdlets`，向系统 WMI 服务查 `Win32_Process`，并在循环中对每个匹配的 Electron/CLI 进程逐个发起 `GetOwnerSid` / `GetOwner` WMI 跨进程调用（桌面端运行时单次可达 15~25 次 RPC），超时仅 `5000ms`。
   - Windows 经历睡眠唤醒、后台更新或杀软扫描时，`WmiPrvSE.exe` 极易慢于 5s；而 AGS 当前账号每分钟自动刷新在 `5000ms` 准时 `TerminateProcess` 强杀正在请求 WMI 的 `powershell.exe`，导致 `WmiPrvSE.exe` 内残留未关闭的 CIM 会话形成恶性循环，直至重启电脑重置 `Winmgmt`。
   - 同文件的 `windowsBoot()` 与 [windows-desktop.ts](../src/windows-desktop.ts) 的 `backendProcesses()`（Codex 关窗时扫全会话进程）同样依赖 `powershell.exe` + `Get-CimInstance Win32_Process`。
2. **【P0 · 主线程卡死与 `storage-unavailable` 元凶】Windows 账号池 DPAPI 密钥校验在主线程同步拉起 `powershell.exe`**：
   - [credential-vault.ts](../src/credential-vault.ts) 的 `dpapi()` 通过 `execFileSync('powershell.exe', ... Add-Type -AssemblyName System.Security ... ProtectedData::Unprotect)`（超时 `15s`）加解密 `.vault-key.dpapi`。
   - 更糟的是，[accounts.ts](../src/accounts.ts) 第 `1410-1411` 行 `const readOnlyUsage = readOnly && !!shared` 仅对 Antigravity 跳过了只读刷新的写密钥预检，导致 **Codex 即使处于 `readOnly = true`（客户端运行中或 `process-unknown` 绝不轮换令牌）时，每分钟仍强制调用 `assertRefreshWriteReady` 同步拉起 `powershell.exe`**，直接造成主界面每分钟冻结 4~8 秒乃至 15 秒超时报 `storage-unavailable`。
3. **【P1 · 桌面重开剩余冷路径 `powershell.exe` 依赖】**：
   - [windows-desktop.ts](../src/windows-desktop.ts) 的 `launchTarget()` 在重开商店版 Codex 时调 `Get-AppxPackage` / `Get-AppxPackageManifest`（5s 超时），在校验自定义目录安装的桌面端发布者时调 `Get-AuthenticodeSignature`（5s 超时），在 `powershell.exe` 退化的机器上同样可能超时导致关窗后自动重开失败。
4. **【P1 · 错误吞没、提示不可操作与诊断缺口】**：
   - `userProcesses()` 与 `credential-vault.ts` 的外层泛化 `catch` 会吞掉 [windows-helper.ts](../src/windows-helper.ts) 的 `WindowsHelperError`，一旦辅助 `.exe` 被安全软件隔离，用户看到的仍是「无法确认运行状态 / 无法读取密钥」而非组件被拦截；
   - 同会话存在以**管理员身份（Run as Administrator）**运行的终端/IDE 跑着 `codex.exe`、`agy.exe` 或桌面端时，普通权限无法打开其进程令牌（`!ownerKnown`），现提示「无法确认 Windows 进程所属用户，请稍后重试」，用户点多少次重试都无法恢复；
   - `userProcesses()` 抛错时未调 `stepDiagnostic('process-unknown')` / `resultDiagnostic('timeout')`，导致失败的 `switch` 在故障报告中 `steps` 为空；
   - macOS 对照核查：macOS 走 `/bin/ps`（`~5ms`）与 `/usr/bin/security`（`~20ms`），不存在 WMI/PowerShell 退化问题，但 [temporary-credentials.ts](../src/temporary-credentials.ts) 第 `147` 行的异步 `/bin/ps` 缺少 `timeout` 与中文错误包装，[macos-desktop.ts](../src/macos-desktop.ts) 第 `16` 行 `failClosed` 超时会直接透传原始英文 `osascript` 错误。

### 修复方案（零新增辅助二进制，复用现有预编译 Helper）

1. **进程快照、开机标识与签名校验并入 [DesktopWindows.cs](../assets/windows/DesktopWindows.cs)**：
   - 新增 `processes [name...]` 子命令：直接调用 Win32 `CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS)` + `ProcessIdToSessionId` + `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` + `GetProcessTimes` + `QueryFullProcessImageName` + `OpenProcessToken(TOKEN_QUERY)` / `GetTokenInformation(TokenUser)`，单次内核快照（`~10ms`）输出当前会话匹配进程的 JSON（保持 `{ pid, parent, name, file, created, ownerKnown }` 结构不变，确认属于其他用户 SID 的进程直接跳过，权限受限无法读令牌的同会话进程保留 `ownerKnown: false`）。
   - 新增 `boot` 子命令：直接读 `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters\BootId` 与 `PID 4` 的 `GetProcessTimes` 创建时间。
   - 新增 `publisher <file>` 子命令：使用 `WinVerifyTrust`（`wintrust.dll`）校验有效 Authenticode 签名并通过 `X509Certificate2.GetNameInfo(X509NameType.SimpleName, false)` 输出签名者名称，替代 `Get-AuthenticodeSignature`。
   - [windows-processes.ts](../src/windows-processes.ts) 的 `userProcesses()`、`windowsBoot()` 与 [windows-desktop.ts](../src/windows-desktop.ts) 的 `backendProcesses()`、`launchTarget()` 全部改调异步 `DesktopWindows.exe`。
   - 商店版 Codex `launchTarget()` 优先直接解析包目录 `<PackageRoot>\AppxManifest.xml` 提取 `<Application Id>` 并按可执行文件路径缓存结果；仅在清单文件不可直读时回退异步查询（超时放宽至 `10s`），彻底消除常规切换/关窗重开中的 `powershell.exe` 调用。
2. **Windows DPAPI 密钥加解密并入 [AntigravityCredential.cs](../assets/windows/AntigravityCredential.cs) + 跳过只读刷新的写密钥预检**：
   - 在 `AntigravityCredential.cs` 新增 `dpapi-protect` 与 `dpapi-unprotect` 子命令，直接 P/Invoke `crypt32.dll` 的 `CryptProtectData` / `CryptUnprotectData`（`CRYPTPROTECT_UI_FORBIDDEN`，附加相同 `service` entropy，清零内存缓冲），无需额外引入程序集，将 [credential-vault.ts](../src/credential-vault.ts) 的 `dpapi()` 从 `4s ~ 15s` 降至 `<10ms`。
   - 在 [accounts.ts](../src/accounts.ts) 第 `1410-1411` 行，当 `readOnly === true` 时各平台统一跳过 `assertRefreshWriteReady`（只读查询不轮换凭据，仅写明文 `_meta.json`；若后续进入 `renewRejectedBearer` 重试分支，第 `1433` 行原本已有 `assertRefreshWriteReady` 兜底），同时减少 macOS 与 Windows 无谓的系统密钥库访问。
3. **分层明确报错文案 + 补齐诊断埋点 + macOS 边界对齐**：
   - **透传 `WindowsHelperError`**：在 `windows-processes.ts`、`windows-desktop.ts`、`credential-vault.ts` 中优先透传 `WindowsHelperError`，并将 [windows-helper.ts](../src/windows-helper.ts) 提示明确为：`Windows 辅助组件缺失或被安全软件拦截，请检查杀毒软件隔离区或重新安装 AgentSwitcher`。
   - **区分 4 类 Windows 进程状态错误**（失败时统一记 `stepDiagnostic('process-unknown')`，超时记 `resultDiagnostic('timeout')`）：
     - 同会话更高权限 CLI/会话进程（`currentUser` 命中 `!row.ownerKnown`）：`检测到同会话存在更高权限的客户端或 CLI 进程（可能以管理员身份运行），请先关闭相关终端或客户端后再切换`；
     - 同会话更高权限桌面主进程（`windowsDesktop` 根进程 `!row.ownerKnown`）：`检测到更高权限运行的 ${name} 桌面进程（可能以管理员身份启动），请先手动退出该客户端后再切换`；
     - 探测超时（`ETIMEDOUT` / `killed`）：`检测 Windows 客户端与 CLI 运行状态超时（系统繁忙），请稍后重试；若反复出现可重启系统恢复`；
     - 其他非预期枚举失败：`无法读取 Windows 客户端或 CLI 进程状态，请检查安全软件拦截后重试；若持续出现可重启系统`。
   - **macOS 超时与诊断对齐**：为 [temporary-credentials.ts](../src/temporary-credentials.ts) 的 `sharedCliSessions` `/bin/ps` 补齐 `{ timeout: 3000 }` 与中文错误/诊断步骤；为 [macos-desktop.ts](../src/macos-desktop.ts) `macDesktopRunning` 的 `failClosed` 异常补齐 `process-unknown` / `timeout` 埋点与可读中文提示。

### 边界约束（不做什么）

- **不新增第 4 个 Windows `.exe` 辅助程序**，严格复用现有的 `DesktopWindows.exe` 与 `AntigravityCredential.exe` 及 `scripts/build-windows-helpers.cjs` 交叉编译（`mcs` / `csc.exe`）与 `sha256.json` 校验链路。
- **不放宽切换时的进程保护边界**：无法确认客户端或 CLI 是否运行时，切换仍严格保持 fail-closed 拦截，绝不盲写凭据。
- [update-handoff.ts](../src/update-handoff.ts) 中仅在应用退出安装更新包时使用的独立 `powershell.exe` 交接脚本不在运行期热路径内，保持不变。

### 代码量基线与预估

当前工作区物理行数基线（建档前）：业务源码 `84` 文件 / `17,864` 行，测试 `59` 文件 / `12,596` 行，开发脚本 `7` 文件 / `656` 行，文档 `37` 文件 / `3,198` 行。预计编码阶段变化如下：

| 类别 | 预计涉及文件 | 预计新增 | 预计删除 | 预计净变化 |
| --- | --- | ---: | ---: | ---: |
| 业务源码 | `assets/windows/DesktopWindows.cs`、`assets/windows/AntigravityCredential.cs`、`src/windows-processes.ts`、`src/windows-desktop.ts`、`src/windows-helper.ts`、`src/credential-vault.ts`、`src/accounts.ts`、`src/temporary-credentials.ts`、`src/macos-desktop.ts` | +225 ~ +310 | -85 ~ -120 | +130 ~ +195 |
| 测试 | `tests/windows-sessions.test.cjs`、`tests/credential-vault.test.cjs`、`tests/accounts.test.cjs` | +90 ~ +140 | -15 ~ -35 | +70 ~ +110 |
| 开发脚本 | 无 | +0 | -0 | 0 |
| 文档 | `docs/account-management.md`、本问题单、`issues/README.md` | +20 ~ +35 | -5 ~ -10 | +15 ~ +25 |

### 验收清单

- [x] `src/` 运行期切换、额度刷新、桌面关停/重开与账号池 DPAPI 读写均不再依赖 `powershell.exe` 或 WMI `Win32_Process`（商店版 `AppxManifest.xml` 直读优先并带缓存）。
- [x] `mcs`（macOS 交叉编译）与 `csc.exe`（Windows 编译）均能零警告编译更新后的 `DesktopWindows.exe` 与 `AntigravityCredential.exe`，且 `dist/windows-helpers/sha256.json` 校验通过。
- [x] `readOnly === true` 的刷新路径不再触发 `assertRefreshWriteReady` 系统密钥库访问；需要续期写回时仍照常完成写前密钥校验。
- [x] `WindowsHelperError`、同会话管理员提权进程冲突、进程探测超时与其他枚举异常分别给出对应明确中文指引，且切换失败时正确写入 `process-unknown` / `timeout` 诊断步骤。
- [x] macOS `sharedCliSessions`（`/bin/ps`）与 `macDesktopRunning`（`failClosed`）具备超时与中文可读错误提示。
- [x] `npm run lint`、`npm test`、`npm run test:ui`、`npm run site:build` 全部通过。

## 3. 修复记录

### 2026-11-27 · Windows 原生探测与只读刷新

- Codex 与 Antigravity 的当前会话进程、桌面后代和启动标识经原有 DesktopWindows 辅助程序查询。无权限的候选保留为未知；切换仍校验用户归属、PID 创建时间、桌面路径以及已确认的进程树。自定义安装路径的发布者取自通过 WinVerifyTrust 核验的签名。
- 商店版 Codex 从注册安装位置的 AppxManifest.xml 选取启动入口，缓存按安装路径和清单版本失效。清单不可读取时才使用限时的包注册查询。已有明确的路径不符、未注册或多入口歧义均会拦住关窗。
- 原有 AntigravityCredential 辅助程序通过二进制管道执行 CurrentUser DPAPI 加解密，沿用旧文件格式和附加熵。只读额度查询跳过写密钥预检，允许真正续期时先校验目标账号池文件。系统存储损坏或辅助程序不可用时保留原文件。
- Windows 权限冲突、组件缺失或拦截、进程探测超时及其他枚举失败分别给出处理指引。macOS 的终端及桌面探测有界等待。诊断仅记录阶段与超时结果。账号流程与刷新文档已同步。

| 开工工作区物理行数 | 开工 | 新增 | 删除 | 净变化 | 收口 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 业务源码 | 17,864 | 431 | 125 | +306 | 18,170 |
| 测试 | 12,596 | 154 | 30 | +124 | 12,720 |
| 开发脚本 | 656 | 1 | 1 | 0 | 656 |
| 文档（包含建档后的本单） | 3,362 | 27 | 5 | +22 | 3,384 |

业务增量主要来自受保护进程的归属与创建时间核验，以及原生签名和 XML 清单校验。脚本仅调整一行编译引用。行数从开工工作副本逐文件对账，未计此前改动、依赖、构建产物或锁文件。

- macOS 隔离自测通过 `npm run lint`、`npm test`（362 通过、5 项按环境跳过、0 失败）、`npm run test:ui`（13 组）及 `npm run site:build`。覆盖只读查询跳过密钥预检、续期前仍检查写权限、权限冲突与超时诊断、桌面重开路径及旧启动标识精度。源码预览已重启并确认主窗口可见。
- 在 macOS 以 Mono `mcs` 编译现有 3 个 Windows 辅助程序，逐一重算 SHA-256 并与 `dist/windows-helpers/sha256.json` 核对。另用 Microsoft `csc.exe` 和 .NET Framework 4.8 引用程序集交叉编译两个改动的辅助程序，两套编译均将警告视为错误并通过。
- 5 项跳过包括 4 项 Windows 原生用例与 1 项需要独立 macOS 用户的钥匙串测试。Windows 的真实 DPAPI 新旧文件互读、原生进程树与窗口关闭仍待 Windows 执行；睡眠唤醒后的切换与刷新时延尚无真机测量。

## 4. 验收记录

- **验收日期与环境**：2026-11-27（macOS 独立代码审查、Win32 ABI 逐字段核验与全量自动化测试通过；与 [AGS-0008](AGS-0008-windows-runtime-and-sandbox.md)、[AGS-0009](AGS-0009-windows-codex-desktop-support.md) 一并保持 `待验收` 待 Windows 10/11 真机终验后归档）。
- **独立核验结果**：
  1. **去 PowerShell / WMI 彻底性**：全仓 `src/` 与 `assets/` 中 `Get-CimInstance`、`windowsQuery` 已清零（`0` 处）；常规切换、后台刷新、桌面关停与账号池 DPAPI 读写均已切换至原生 `DesktopWindows.exe` 与 `AntigravityCredential.exe`（仅商店包清单文件不可直读的极端回退与退出安装更新交接保留独立脚本）。
  2. **Win32 P/Invoke 结构体与安全边界**：逐字段核对 [DesktopWindows.cs](../assets/windows/DesktopWindows.cs)（`PROCESSENTRY32W`、`SYSTEM_PROCESS_INFORMATION` 含当前进程 `GetProcessTimes` 运行期 ABI 自检、`GetPackagePathByFullName` + 禁 DTD/XXE 的 `AppxManifest.xml` 解析、`WINTRUST_FILE_INFO`/`WINTRUST_DATA`/`CRYPT_PROVIDER_CERT` 及 `PostMessage` 提权窗口拒绝码 `5`）与 [AntigravityCredential.cs](../assets/windows/AntigravityCredential.cs)（二进制管道 `CryptProtectData`/`CryptUnprotectData`、输入长度校验及托管/非托管缓冲清零），32/64 位内存布局与旧版 `.vault-key.dpapi` 密文格式完全兼容；`earlierWindowsBoot` 已兼容历史 WMI 微秒截断回执（`±9` ticks 容差）。
  3. **只读刷新免预检与分层报错诊断**：[accounts.ts](../src/accounts.ts) 在 `readOnly === true` 时统一跳过 `assertRefreshWriteReady`，`QuotaBearerRejected` 转入真实续期前仍强制执行写密钥校验；4 类 Windows 错误（安全软件拦截/缺失 `WindowsHelperError`、管理员提权 CLI/桌面冲突、探测超时、其他枚举失败）及 macOS `/bin/ps`（3s）与 `osascript`（2s）超时提示清晰可操作，且 `processProbeError` 均正确落盘 `process-unknown` 与 `timeout`。
  4. **构建、测试与行数复核**：
     - `dist/windows-helpers/{AgySandbox,AntigravityCredential,DesktopWindows}.exe` 与 `sha256.json` 摘要逐一核对一致；
     - `npm run lint`、`npm test`（`362` 通过 / `0` 失败 / `5` 环境跳过）、`npm run test:ui`（`13/13` 组全过）、`npm run site:build` 全部通过，全仓 Markdown 本地链接 `0` 断链，macOS 源码预览进程运行正常；
     - 独立复算物理行数与第 3 节账目完全吻合：业务源码 `17,864 -> 18,170`（`+431 / -125`，净 `+306`，超预估部分来自 `NtQuerySystemInformation` 受限进程回退自检与原生 `WinVerifyTrust`/`AppxManifest` 完整校验，合理必要）、测试 `12,596 -> 12,720`（`+154 / -30`，净 `+124`）、开发脚本 `656 -> 656`（`+1 / -1`，净 `0`）。
- **Windows 真机联验关注点（随 AGS-0008 / AGS-0009 合并终验后关单）**：
  - 在 Windows CI 或真机实跑 4 项原生用例（含新增的新旧 `.NET ProtectedData` ↔ 原生 `CryptUnprotectData` 互读用例）；
  - 在原故障 Windows 设备验证睡眠唤醒后的 Codex 切换与每分钟自动刷新耗时（确认无 `process-unknown` / `storage-unavailable`）；
  - 顺带留意自定义目录安装场景下 [DesktopWindows.cs](../assets/windows/DesktopWindows.cs) 第 `229` 行 `Revoke = 1`（`WTD_REVOKE_WHOLECHAIN`）在仅配用户态本地代理、WinHTTP 无法直连海外 CRL/OCSP 时的耗时表现（若出现离线吊销查询阻塞，可改为 `Revoke = 0` 或附加 `WTD_CACHE_ONLY_URL_RETRIEVAL = 0x1000` 与原 `Get-AuthenticodeSignature` 对齐）。
