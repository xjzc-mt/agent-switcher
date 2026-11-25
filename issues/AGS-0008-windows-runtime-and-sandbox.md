# AGS-0008 · Windows 沙箱与进程容错修复及多平台底层拆文件解耦

- 状态：待验收
- 类型：跨平台兼容性缺陷 / 多平台分层解耦
- 来源：2026-11-23 全量质检（静态源码与 Windows 系统机制核查）
- 环境：Windows 10 / 11 x64 及 Windows 11 ARM64（Prism 模拟环境）

## 1. 现象与复现

当前工作区未提交的 Windows 适配代码在静态审查中暴露出以下 6 类真实用户环境阻断问题，因需在真实 Windows 设备联调，特此集中建档备查：

1. **开启本地代理（`127.0.0.1`）或自定义根证书时，Antigravity 备用账号刷新 100% 失败**：[windows-usage.ts](../src/windows-usage.ts) 虽透传了 `HTTP_PROXY` / `HTTPS_PROXY` 与 `SSL_CERT_FILE`，但 [QuotaProcess.cs](../assets/windows/QuotaProcess.cs) 每次创建随机 GUID 的 Windows AppContainer（仅授予 `S-1-15-3-1` `internetClient`）。Windows 内核网络隔离默认禁止 AppContainer 连接本机 Loopback（如 Clash / v2rayN `127.0.0.1:7890`）及局域网代理，且随机 SID 无法配置 Loopback 豁免；同时当前用户 SID 被设为 `SE_GROUP_USE_FOR_DENY_ONLY`，导致子进程无权读取 `%USERPROFILE%` 下的自定义证书文件。
2. **查询超时强杀导致备用账号跨系统重启永久锁死**：Windows 下 `child.kill('SIGTERM')` 直接调用 `TerminateProcess` 强杀 `AgySandbox.exe`，跳过 `QuotaProcess.cs` 写出 `.ags-win-drained-<pid>` 回执；若叠加 `pendingAntigravityQuota` 未核对 `earlierWindowsBoot`，该账号即使重启 Windows 仍持续报错 `PendingQuotaConflict`。
3. **进程枚举在多用户、UAC 管理员提权或第三方 IDE 共存时报错阻断切换**：
   - [windows-processes.ts](../src/windows-processes.ts) 第 `20-23` 行枚举整机 `Win32_Process` 调 `GetOwnerSid`，遇到管理员提权进程、其他登录会话进程返回 `Access Denied (2)` 或进程瞬时退出返回非 0 时直接抛 `'Owner unavailable'`，导致切换失败、刷新退回只读；
   - 第 `50-51` 行按泛化进程名 `language_server.exe` 匹配并在 `ExecutablePath` 为空时直接抛错，与 Codeium / Windsurf / MSIX 工具冲突。
4. **多窗口/托盘态关窗不完整且不支持自定义安装目录重开**：`$app.CloseMainWindow()` 仅向单个顶层窗口句柄发一次 `WM_CLOSE`，多工作区窗口或最小化托盘态无法退净，且渲染子进程伴随退出时易误判 `'Desktop changed'`；[clients.ts](../src/clients.ts) 第 `14-28` 行将安装路径硬编码为 `%LOCALAPPDATA%\Programs` 与 `%ProgramFiles%`，装在其他盘符（如 `D:\Apps`）时关闭后重开报错。
5. **主线程同步调 `powershell.exe` + `csc.exe` 在 `%TEMP%` 编译 `.exe` 卡顿且易触发 Defender ASR 拦截**：首次读写凭据在主线程同步编译阻塞最长可达 25s，在 `%TEMP%` 生成并运行未签名 `.exe` 易被 Windows Defender ASR 规则拦截，`AgySandbox.exe reap` 后台锁镜像导致退出清理泄漏，且自定义 `TEMP`（如 `D:\Temp` 或 Dev Drive 重解析点）会因严苛 ACL 检查直接失败。
6. **Windows 窗口壳层、深色托盘与 ARM64 细节**：未设 `autoHideMenuBar: true` 暴露默认英文菜单栏；纯黑 `#000000` 的 `trayTemplate.png` 在 Windows 11 深色任务栏几乎不可见；点击托盘调 `focus()` 未调 `revealMainWindow()` 无法恢复最小化窗口；Windows 11 ARM64 下漏检 `@openai/codex-win32-arm64`（`aarch64-pc-windows-msvc`）CLI；`antigravity-native.ts` 的 `sameFile` 未使用 `{ bigint: true }` 读取 64 位 NTFS File ID。
7. **部分底层模块仍将 macOS 与 Windows 实现混写在同一文件内**：当前 `renderer/` 前端（0 处系统判断）与独立 `windows-*.ts` 文件已隔离良好，但全仓 `src/` 仍有 71 处 `process.platform` 判断，主要集中在 [antigravity-native.ts](../src/antigravity-native.ts)（1,193 行，含 17 处 `darwin/win32` 分支，混放了 Mac JXA/`security` 钥匙串脚本与 Windows 凭据调用）、[antigravity-cli.ts](../src/antigravity-cli.ts) 与 [clients.ts](../src/clients.ts)（共 12 处系统分支穿插），以及核心编排层 [accounts.ts](../src/accounts.ts) 残留的最后 2 处 `win32` 判断（第 `477`、`1289` 行）。

## 2. 根因与修复方案

### 多平台代码维护准则（单主干代码库 + 底层按系统拆文件）

- **坚持单一 Git 主分支（Single Codebase），绝不拆分 Mac / Windows 独立代码分支**：避免功能演进、安全补丁与新平台接入时跨分支手工搬运漏合，保证每次发版从同一提交构建三端安装包与校验清单。
- **三层隔离边界**：
  1. **界面与核心编排层（100% 跨平台共用，0 处 `process.platform`）**：`renderer/`、`accounts.ts`、`backup.ts`、`credential-import.ts` 等完全不感知操作系统；
  2. **系统底层适配层（对外统一窄接口，对内按系统拆独立小文件）**：钥匙串/凭据库、沙箱/Job 隔离、桌面进程查找与关停、托盘与菜单栏分别收敛至对等的 `mac` / `windows` 适配模块；
  3. **构建打包裁剪层**：`electron-builder` 按目标平台剔除异构系统专属资源（如 Mac 包排除 `assets/windows/**/*`，Windows 包排除 Mac 专属模板图标）。

### 初步方向（待上 Windows 实机敲定细节后转为 `待修复`）

1. **隔离模型对齐 macOS `sandbox-exec` 边界**：去掉封锁本机 Loopback 代理的随机 AppContainer，改用 **Job Object（`KILL_ON_JOB_CLOSE`）+ 独立临时目录 `USERPROFILE`/`APPDATA`/`LOCALAPPDATA` 环境变量隔离 + stdin 温和退出回执**，确保本机代理可用且子进程树可干净排空。
2. **构建期预编译 Helper 替代运行期 `%TEMP%` 编译**：在打包构建阶段预编译单一受校验的 Windows Helper 随 `asarUnpack` 分发，改为异步或长驻 stdio 调用，消除主线程冻结与 `%TEMP%` 动态生成可执行文件行为。
3. **进程识别与窗口壳层补齐**：`GetOwnerSid` 忽略非当前用户与已退出进程，按完整路径特征过滤 Antigravity `language_server.exe`，枚举目标主进程全部顶层窗口关闭并信任运行态实测路径重开（与 [AGS-0009](AGS-0009-windows-codex-desktop-support.md) 共用桌面客户端关停/重开底层）；补齐 `autoHideMenuBar`、Windows 高对比彩色托盘图标、`revealMainWindow()`、`aarch64` Codex CLI 探测及 Windows 应用内签名安装包下载支持。
4. **按系统拆分混写底层模块，清零 `accounts.ts` 系统分支**：
   - 从 `src/antigravity-native.ts` 抽离 macOS 专属 JXA/`security` 钥匙串实现至 `src/antigravity-mac.ts`，与 `src/antigravity-windows.ts` 对称实现统一原生存储接口，`antigravity-native.ts` 仅保留跨平台共用的双文件优先级、会话比对与切换恢复事务；
   - 收拢 `src/antigravity-cli.ts` 与 `src/clients.ts` 中穿插的系统启动/关停分支；
   - 将 `src/accounts.ts` 剩余的 2 处 `win32` 特判下沉至 `BaseAgent` 能力钩子，实现核心编排层 **0 处操作系统判断**。

### 待实机确认清单

- [ ] 在开启 Clash / v2ray 本地代理（`127.0.0.1`）的 Windows 11 真机验证 Antigravity 备用账号查额与续期连通性。
- [ ] 在同时开启 UAC 管理员终端、多工作区窗口及深色任务栏的 Windows 11 真机验证切换、关窗重开与托盘唤醒体验。
- [ ] 完成 `antigravity-mac.ts` / `antigravity-windows.ts` 对称拆分且确认 `src/accounts.ts` 零 `process.platform` 判断，Mac 与 Windows 打包产物互不混入对方专属资源。
- [ ] 结合 [AGS-0003](AGS-0003-desktop-only-accounts.md) 一并确认纯桌面安装与 CLI 安装的边界，敲定最终方案与代码量预估后再进入编码。

## 3. 修复记录

- 2026-11-23，按维护者确认的范围完成源码修复。本单与 AGS-0009 共用 Windows 桌面适配，两个问题单均保留独立真机验收。
- 备用账号改用禁用用户 SID 的受限令牌、每次查询唯一的限制 SID、低完整性临时主目录及 Job Object。子进程只继承标准输入输出句柄，沿用配置的本机代理。辅助程序会核对宿主凭据目录权限。逐项检查真实 .gemini 与 .agent-switcher 的访问权限。遇到重解析点或盘点超过 10 万项、12 秒时，会在官方 CLI 启动前结束查询。只在临时工作区授予本次运行权限，宿主 ACL 和系统回环策略保持原状。[受限令牌](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens) · [CredReadW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw) · [CredWriteW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew)
- 取消查询先通知启动器排空 Job，父进程根据回执决定是否可重试。若确实启动过且续期结果未知，继续保留恢复副本。旧根目录不可读仅影响与该目录有未决恢复记录的账号。AGS-0005 已实现开机轮次检查，本次沿用。
- 统一当前用户的桌面与 CLI 识别，跳过能确认属于别人或已经退出的进程。自定义安装从已确认的原路径重开。同名语言服务的安装路径或关键进程归属仍无法确认时，暂停切换。Windows 托盘可还原最小化窗口，原生菜单默认收起。x64 更新按已签名的清单下载匹配的 EXE。
- 为避免把宿主用户的凭据操作与受限额度子进程放入同一入口，保留凭据、额度与窗口三个辅助程序，构建时统一编译并核对清单。拆分 macOS 钥匙串、桌面和沙箱实现，Windows 文件标识使用大整数。共享账号编排与导入、备份的命名策略调用平台接口。ARM64 原生 npm 组件在修复前已有支持，本次补充 x64 应用运行于 ARM64 主机的探测。
- 代码量与 AGS-0009 同批对账，基线为本轮开始时的工作区。桌面识别和关停等两单共用的模块计入本单。本单物理行数按“基线／新增／删除／净增／修复后”统计。业务 14,615／1,172／664／508／15,123，测试 10,696／425／88／337／11,033，脚本 451／114／0／114／565，文档 1,680／43／23／20／1,700，配置 171／14／6／8／179。源码和测试高于最初预估，来自平台模块拆分、受限令牌重设计和一次性普通用户的原生验收。
- npm run lint、npm test（340 通过，5 项需独立系统环境）、npm run test:ui（13 组）和 npm run site:build 均通过。三个 Windows PE 已交叉编译并校验摘要。macOS/Mono 上用合成 CLI 完成一次真实回环 HTTP 请求和一次模拟续期写回。Windows 专项包含本机代理往返、WinCred 读写拒绝、跨查询文件隔离、权限过宽拒绝启动和 Job 排空。Windows 内核专项需在一次性标准用户环境执行。真实 agy、企业网络策略、托盘视觉与实体客户端待独立验收。

### 2026-11-23 Windows 备用额度返修

- 解析用户主目录和漫游应用数据目录的重定向目标，核对真实路径的防写权限。Gemini 检查两份官方凭据、两份回退标记及其父目录，避免扫描其他项目的文件和链接。AGS 账号池继续逐项保护。
- 启动前用实际受限令牌打开官方程序，能读和执行就用原安装文件。仅在缺少权限时才使用固定缓存，按源路径、文件标识、大小、时间和 SHA-256 复用。缓存对查询进程只读，并发查询协调首次复制，运行期间持有程序文件句柄。
- 在 macOS 交叉编译 Windows 辅助程序并核对摘要。在隔离模拟中验证了直接执行、首次缓存、重复命中、缓存损坏后恢复及安装文件升级。Windows 原生用例已覆盖重定向、无关 Junction、已知凭据权限过宽和并发首次复制，待独立 Windows 环境实跑。
- 本批 lint、单测（340 通过、0 失败、5 跳过）、13 组 UI 与站点构建全部通过。《额度刷新》已同步。共用的桌面检测与关窗改动及其测试计入 AGS-0009。
- 本轮物理行数账目（修前／新增／删除／净变化／修后）：业务 388／176／28／+148／536，测试 263／40／8／+32／295，文档 212／15／5／+10／222。含本批共用的问题索引。源码净增高于预估，主要用于程序缓存的权限核验、并发发布和版本校验。脚本与配置无变更。

## 4. 验收记录

- **验收日期与环境**：2026-11-23（macOS 独立代码审查与自动化核验；Windows 真机尚未联调）。
- **自动化验证结果**：
  - `npm run lint` 通过；
  - `npm test` 通过（340 通过 / 0 失败 / 5 项因需专用系统环境跳过）；
  - `npm run test:ui` 13 组全部通过（首次运行 `chrome` 悬停用例受本机桌面光标焦点波动失败，重跑全量通过）；
  - `npm run site:build` 通过，全仓 Markdown 本地链接检查 0 断链；
  - 静态对照 `app-builder-lib` 源码确认：`package.json` 的 `win.files` 会追加到根 `files` 正确排除 `trayTemplate*.png`，`win.signExts`（`!AgySandbox.exe` 等）与 `beforePack` 暂存签名方案有效，不会在签名后重复签名破坏 `sha256.json`。
- **已验证通过项**：
  - 多平台分层解耦达标：`src/accounts.ts` 已清零 `process.platform`（0 处）；完成 `antigravity-mac.ts` / `antigravity-windows.ts` / `antigravity-keyring.ts`、`mac-usage.ts` / `windows-usage.ts`、`macos-desktop.ts` / `windows-desktop.ts` 对称拆分，`antigravity-native.ts`（1,193 → 946 行）与 `clients.ts`（45 行）显著瘦身；
  - 隔离模型已放弃阻断 `127.0.0.1` 的随机 AppContainer，改为受限令牌 + Job Object + 临时主目录，且 `windows-usage.ts` 仅提取公开 X.509 证书（剥离私钥）；
  - 构建期预编译 Helper 替代运行期 `%TEMP%` 调 `csc.exe`，并接入 `sha256.json` 校验；
  - `stopWindowsQuota` 停止信号 + `.ags-win-drained-<pid>` 回执 + 开机轮次保护、`autoHideMenuBar`、Windows 彩色托盘图标 `gate-mark.png`、`revealMainWindow()`、x64-on-ARM64 探测、64 位 NTFS `bigint` `ino` 与 Windows x64 签名更新器均已按预期落地。
- **验收未通过项（退回 `待修复`，须先于 Windows 真机联调前解决）**：
  1. **【P0 · 实机必现阻断】`QuotaProcess.cs` 每次隔离查额对 `%USERPROFILE%\.gemini` 递归全树 ACL 盘点，真实 Antigravity 用户环境极易永久失败（退出码 `124`）**：
     - 位置：`assets/windows/QuotaProcess.cs:198-271`（尤其第 `199`、`219`、`258-265` 行）。
     - 问题：`CheckHostBoundaries` 对 `.gemini` 传了 `tree: true`，且遇到任意 `ReparsePoint`（第 `219` 行）、总项数超 `100000` 或耗时超 `12000ms`（第 `199` 行）即抛错终止。真实用户的 `.gemini` 包含 `antigravity/brain/`、`conversations/`、`code_tracker/`、`extensions/`、`skills/` 等大量文件，极易含 skill/MCP 软链、NTFS Junction、OneDrive 占位符或带 `S-1-15-2-1` 可读的非凭据文件，会直接导致所有备用账号查额在 `agy.exe` 启动前失败（CI 空用户未覆盖此现场）。
     - 修复要求：与 `.codex`（第 `261-262` 行）及 `%APPDATA%\Antigravity`（第 `266-268` 行）一致，`.gemini` 仅校验目录防写与已知凭据文件路径，禁止递归遍历整棵 `.gemini` 数据树；同时避免因 `%USERPROFILE%` / `%APPDATA%` 常规目录重定向（Junction）误伤。
  2. **【P0 · 性能与 `%TEMP%` 执行退化】`StageExecutable` 每次隔离查询拷贝完整 `agy.exe`（实测 ~219 MB）到 `%TEMP%\...\cli-bin\agy.exe` 并执行**：
     - 位置：`assets/windows/QuotaProcess.cs:141-151, 305, 373`。
     - 问题：单次过期备用账号刷新（ACP + `/usage`）会向 `%TEMP%` 写入并执行约 440 MB；5 个备用账号「刷新全部」将产生 1.1–2.2 GB 临时写入，反复触发 Windows Defender 实时查杀锁文件，且重新引入「在 `%TEMP%` 落地并运行 `.exe` 易触发 Defender ASR」问题，若未来 Windows 版 `agy.exe` 附带同目录依赖文件也会失效。
     - 修复要求：优先检测原安装路径是否可被受限令牌直接读取执行；若确需为受限令牌准备副本，改为落盘至固定应用缓存目录并按源文件 `(路径/大小/mtime/SHA-256)` 复用只读缓存，禁止按次拷贝 220 MB 到 `%TEMP%` 执行。
  3. **【P0 · 高危关窗中断，同时影响 AGS-0009】`DesktopWindows.cs` 使用 `.NET Process.Handle`（`PROCESS_ALL_ACCESS`）打开全部 Electron 子进程，遇 AppContainer 沙箱子进程或瞬时退出子进程会抛未捕获 `Win32Exception` 直接失败**：
     - 位置：`assets/windows/DesktopWindows.cs:23-43`、`src/windows-desktop.ts:138-142`。
     - 问题：`quitWindowsDesktop` 将 `windowsDesktop` 返回的全部进程（含 `--type=renderer` / `--type=gpu-process` / `--type=utility`）均作为 `window:` 传给 `DesktopWindows.exe`；`DesktopWindows.cs:32` 调用 `.NET Process.Handle` 请求 `PROCESS_ALL_ACCESS`（`0x1F0FFF`），当遇到启用 AppContainer 沙箱的 Chromium 子进程（如 `NetworkService`）返回 `Access Denied`，或任一子进程在 `GetProcessById` 与 `process.Handle` / `StartTime` 之间瞬时退出抛出 `Win32Exception` 时，因第 `42` 行仅捕获 `InvalidOperationException` 未捕获 `Win32Exception`，会直接落入第 `64` 行 `catch { return 1; }`，在发送任何 `WM_CLOSE` 前即整批失败。CI 测试 `tests/windows-sessions.test.cjs:184-213` 绕过了 `windowsDesktop` 与多子进程树（仅传单个主 PID 与 `Get-Process StartTime`），未能覆盖真实生产路径。
     - 修复要求：`DesktopWindows.cs` 改为 P/Invoke 最小权限 `OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION)` + `GetProcessTimes` + `QueryFullProcessImageName` + `WaitForSingleObject` / `WaitForMultipleObjects`，对已退出进程容错；`quitWindowsDesktop` 仅对主进程（`rootProcesses`）发 `window:`、其余子进程走 `wait:`；补强 Windows CI Electron 用例以覆盖真实 `windowsDesktop` 枚举（`Get-CimInstance CreationDate`）与完整子进程树关窗。
  4. **【P1 · 进程枚举仍受跨会话与沙箱子进程阻断】非提权状态下 `GetOwnerSid` 对跨会话用户、UAC 提权进程及 Chromium AppContainer 子进程均返回 `ReturnValue = 2`**：
     - 位置：`src/windows-processes.ts:22-73`、`src/windows-desktop.ts:31-39`。
     - 问题：普通用户无法通过 `GetOwnerSid` 读取另一登录会话（快速用户切换）或提权进程的 SID，结果 `ownerKnown` 为 `false`、`file` 为 `null`，`currentUser()`、`sharedWindowsAntigravityPids()` 与 `windowsDesktop()` 仍抛错阻断切换与桌面检测；且若 Electron 沙箱子进程在 WMI 中无法读回路径/SID，将导致整批 `windowsDesktop()` 失败。
     - 修复要求：查询纳入 `SessionId` 直接跳过非当前会话进程；`windowsDesktop()` 对已确认桌面主进程派生出的沙箱子进程不因 WMI 权限受限整批报错；明确收窄泛化 `language_server.exe` 对第三方提权/沙箱 IDE 进程的误阻断。
- **后续真机复验提醒**：上述 4 项修复并复验通过后，仍需在真实 Windows 10/11 设备补齐第 2 节实机清单，并额外核验真实 Windows `agy.exe -p /usage` 在 `shared` 模式 `ProcessLimit = 1U`（`QuotaProcess.cs:293`）下是否会因派生子进程被限流。
- **验收结论**：**不通过，退回 `待修复`**。

### 二次独立复验 · 2026-11-24（源码与自动化通过，保持 `待验收` 待 Windows 实机终验）

- **前轮 4 项阻断缺陷复核结果（全部修复达标）**：
  1. **`.gemini` 边界检查与目录重定向（[assets/windows/QuotaProcess.cs](../assets/windows/QuotaProcess.cs) 第 `365-422` 行）**：已取消对 `.gemini` 的 `tree: true` 递归盘点，改为仅校验 `.gemini` 下 4 个认证/缓存目录的防写权限与 4 个已知凭据/回退标记文件；`HostFolders` 通过 `CreateFile` + `GetFinalPathNameByHandle` 解析 `%USERPROFILE%` 与 `%APPDATA%` 的常规 Junction 重定向目标并核对防写，不再因 `.gemini` 内的软链或海量项目文件误报 `124`。
  2. **219 MB `agy.exe` 只读程序缓存（[assets/windows/QuotaProcess.cs](../assets/windows/QuotaProcess.cs) 第 `157-281` 行）**：启动前先以受限令牌模拟检测原安装文件是否已具备 `GENERIC_READ | GENERIC_EXECUTE`（满足则零拷贝直接运行）；否则使用 `%LOCALAPPDATA%\AgentSwitcher-QuotaCLI` 固定受保护目录（仅宿主用户可写，授予 `S-1-5-11` 与 `S-1-15-2-1` 只读执行），通过跨进程 `.lock` 文件锁串行化冷启动复制，热命中按源文件与缓存文件的 `(Volume, FileIndex, Length, Written, Changed)` O(1) 校验复用并在 Job 排空前持有只读文件句柄，彻底消除每次向 `%TEMP%` 拷贝执行 219 MB 二进制的问题。
  3. **最小权限窗口关闭与子进程退净等待（[assets/windows/DesktopWindows.cs](../assets/windows/DesktopWindows.cs) + [src/windows-desktop.ts](../src/windows-desktop.ts)）**：已放弃 `.NET Process.Handle`（`PROCESS_ALL_ACCESS`），改用 P/Invoke `OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION)` + `GetProcessTimes` 微秒级比对；`quitWindowsDesktop` 仅向 `rootProcesses` 发送 `window:`（`WM_CLOSE`），其余桌面子进程传 `wait:`，且对拒绝句柄打开的严格沙箱子进程降级轮询等待退出（`protectedChildren`），对瞬时已退出进程（`ERROR_INVALID_PARAMETER = 87`）安全跳过。
  4. **当前会话过滤与泛化语言服务收窄（[src/windows-processes.ts](../src/windows-processes.ts) + [src/windows-desktop.ts](../src/windows-desktop.ts)）**：WMI 查询已限定 `SessionId=$session` 排除跨用户会话干扰，`$live.Path` / `StartTime` 已包裹异常容错；`windowsDesktop` 仅要求主进程具备完整路径与归属，允许沙箱子进程隐藏路径/SID；无品牌前缀的 `language_server.exe` 在路径不可读时不再阻断 Antigravity 切换。
- **自动化与宿主核验**：`npm run lint`、`npm test`（340 通过 / 0 失败 / 5 环境跳过）、`npm run test:ui`（13 组全过）、`npm run site:build`、Markdown 断链检查（0 断链）及 macOS 宿主桌面/CLI 探测均通过，且 `dist/` 未混入 Windows `.exe` 产物。
- **待 Windows 设备终验清单（完成后即可关闭本单）**：
  - 在 GitHub Actions Windows runner 或本地 Windows 编译实跑 3 项原生跳过用例（`windows-usage-runner.test.cjs` 标准用户沙箱用例、`windows-sessions.test.cjs` 多进程 Electron 关窗与 CIM 用例）；
  - 在开启 `127.0.0.1` 本地代理（Clash / v2rayN）的 Windows 10/11 真机验证真实 `agy.exe` 的备用账号续期查额与当前账号共享查额（重点确认 `shared` 模式 `ProcessLimit = 1U` 与真实 `agy.exe -p /usage` 兼容），并核验深色任务栏托盘唤醒及多窗口关停重开体验。
