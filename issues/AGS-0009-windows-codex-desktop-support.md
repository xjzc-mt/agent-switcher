# AGS-0009 · Windows 仅安装官方 Codex 桌面端时无法查询额度与自动重启客户端

- 状态：待验收
- 类型：跨平台兼容性与桌面客户端闭环缺陷
- 来源：2026-11-23 Windows `1.0.1` 实机用户故障报告与界面反馈（关联 [AGS-0003](archive/AGS-0003-desktop-only-accounts.md)、[AGS-0008](AGS-0008-windows-runtime-and-sandbox.md)）
- 环境：Windows 10 / 11 x64（及 ARM64），仅安装官方 Codex 桌面端（Microsoft Store / MSIX 包 `OpenAI.Codex_*`），未单独安装 Node.js 或独立 Codex CLI

## 1. 现象与复现

1. **导入与切换成功，但所有账号均显示「查询失败（未找到 Codex CLI）」**：
   - 在仅安装官方 Codex 桌面端的 Windows x64 设备运行 `AgentSwitcher 1.0.1`，导入两个 Codex 账号并在两者间往返切换。
   - 脱敏故障报告（`AGS-故障报告.json`）记录 `import` 与两次 `switch` 均为 `result: "ok"`（耗时 340ms / 262ms），证明 `%USERPROFILE%\.codex\auth.json` 读写、加密账号池解密与 [codex-file-auth.ts](../src/codex-file-auth.ts) 存储模式检查均正常通过。
   - 界面中当前账号与备用账号卡片均显示 `⚠ 查询失败`（无「更新」或「登录」按钮，排除凭据失效与 401 拒绝），悬停提示确认为 **`未找到 Codex CLI`**。
   - 切换后自动触发的非强制刷新（`force = false`）因命中 `_meta.json` 中 `state: 'error'` 的 2 / 5 / 15 分钟退避窗口，在 6–9ms 内直接返回 `step: "cached"`，导致未手动点「刷新全部」前导出的故障报告未包含底层失败步骤。
2. **Codex 桌面端运行时的切换关停与「重启客户端」按钮未打通**：
   - Codex 桌面端打开时点击「切换」，Windows 下无法像 macOS 一样弹窗执行「退出并切换 → 自动重开桌面端」，而是直接报错拦截，要求用户手动退出并手动重开客户端。
   - 当前账号卡片右侧的「重启客户端」按钮在 Windows 点击后仅提示「没有需要重启的桌面客户端」。

## 2. 根因与修复方案

### 根因定位

1. **漏检 Windows 商店版桌面端解出的内置 `codex.exe`**：
   - 官方 Codex 桌面端与 macOS `Codex.app` 一样自带完整的 `codex.exe`（支持 `app-server` 协议），无需用户额外安装独立 CLI。
   - 因商店版主目录 `C:\Program Files\WindowsApps\OpenAI.Codex_*` 受系统保护无法直接调起，桌面端首次启动时会将内置 `codex.exe` 解出到用户 `LocalAppData` 运行缓存目录。受 Windows MSIX 虚拟文件系统（VFS）重定向影响，实际路径落在 `%LOCALAPPDATA%\Packages\OpenAI.Codex_*\LocalCache\Local\OpenAI\Codex\bin\<16位hex>\codex.exe` 或 `%LOCALAPPDATA%\OpenAI\Codex\bin\<16位hex>\codex.exe`。
   - `1.0.1` 正式版两处均未扫描；当前工作区未提交的 [codex-process.ts](../src/codex-process.ts) 仅补充了非重定向路径，仍遗漏 MSIX `Packages\OpenAI.Codex_*\LocalCache\Local\...` 路径，且桌面端刚安装尚未首次打开初始化时仍误报 `未找到 Codex CLI`。
2. **Windows 客户端生命周期仅实现了 Antigravity 特判**：
   - [clients.ts](../src/clients.ts) 与 [windows-processes.ts](../src/windows-processes.ts) 在 Windows 上仅针对 `Antigravity` 编写了专用识别与关窗逻辑，`runningClients('codex')` 恒返回 `[]`，导致切换编排与「重启客户端」按钮无法接管 Windows Codex 桌面端。

### 修复方案（复用现有通用流程，零冗余分支）

1. **补齐桌面内置 `codex.exe` 缓存扫描与未初始化提示**：
   - 在 [src/codex-process.ts](../src/codex-process.ts) 现有的 `<16位hex>\codex.exe` 缓存扫描循环中，同时纳入 `%LOCALAPPDATA%\OpenAI\Codex\bin` 与 `%LOCALAPPDATA%\Packages\OpenAI.Codex_*\LocalCache\Local\OpenAI\Codex\bin`，按修改时间选取最新可执行文件；下游 `startCodexProcess`、`queryLiveRpc`、`codexLogin` 100% 复用现有通道（有独立 CLI 时优先命中前序 `PATH` / `npm`，仅装桌面端时自动兜底命中桌面内置组件）。
   - 在 [src/agents/codex.ts](../src/agents/codex.ts) 中，若未找到可执行文件但检测到 `%LOCALAPPDATA%\Packages\OpenAI.Codex_*` 已存在，返回明确提示「请先打开一次 Codex 桌面端完成初始化后再刷新」，避免误导用户安装 CLI。
2. **收拢 Windows 桌面客户端通用识别、安全关停与重开**：
   - 将 [src/windows-processes.ts](../src/windows-processes.ts) 与 [src/clients.ts](../src/clients.ts) 中仅面向 Antigravity 的桌面进程查询与 `WM_CLOSE` 关窗等待泛化为通用桌面辅助函数，消除单平台硬编码（同时按 [AGS-0008](AGS-0008-windows-runtime-and-sandbox.md) 忽略非当前用户或瞬时退出进程的 `GetOwnerSid` 返回码）。
   - **识别与关停**：匹配当前用户的 Codex 桌面主进程（`WindowsApps\OpenAI.Codex_*\app\Codex.exe` 或 `%LOCALAPPDATA%\Programs\OpenAI\Codex\Codex.exe`），发送 `WM_CLOSE` 并等待桌面主进程及其派生的 `codex.exe`（`app-server`）子进程全部退出后再切换 `auth.json`，防止旧会话退出时回写覆盖新凭据；底层 `runningCodexSessions()` 保持不变，继续兜底保护仍在运行的独立终端 CLI 会话。
   - **自动重开**：常规目录安装直接启动原 `Codex.exe`；商店 MSIX 包通过 `Get-AppxPackage` 解析 `PackageFamilyName` 与 `AppId`，经系统标准入口 `explorer.exe shell:AppsFolder\<PackageFamilyName>!<AppId>` 重新拉起。主流程 [src/main.ts](../src/main.ts) 与前端 [renderer/app.js](../renderer/app.js) 零改动复用。

### 边界约束（不做什么）

- **不借助 VS Code / Cursor 等任何第三方或 IDE 插件目录**提供运行时，也不要求纯桌面用户安装 Node.js 或独立 CLI。
- 不复制第二套查额、续期或切换编排逻辑；遵循 [AGS-0008](AGS-0008-windows-runtime-and-sandbox.md) 单主干分层约定，`main.ts`、`accounts.ts` 与 `renderer/` 维持零新增系统分支的统一接口，Windows 专属逻辑严格收敛在底层平台适配文件中。
- Windows 下删除当前账号时的客户端同步登出清理（`client-logout.ts`）待桌面端关停与落盘行为在 Windows 真机验收通过后再评估是否开放。

### 代码量基线与预估

当前工作区物理行数基线（建档前）：业务源码 73 文件 / 15,425 行，测试 57 文件 / 10,940 行，开发脚本 5 文件 / 451 行，文档 24 文件 / 1,987 行（其中 `issues/` 9 文件 / 724 行）。本次建档仅新增本文件并更新 `issues/README.md` 索引 1 行；后续进入编码修复时的预估变化如下：

| 类别 | 预计涉及文件 | 预计新增 | 预计删除 | 预计净变化 |
| --- | --- | ---: | ---: | ---: |
| 业务源码 | `src/codex-process.ts`、`src/agents/codex.ts`、`src/windows-processes.ts`、`src/clients.ts` | +60 ~ +90 | -15 ~ -30 | +40 ~ +65 |
| 测试 | `tests/codex-process.test.cjs`、`tests/windows-sessions.test.cjs` | +40 ~ +65 | -0 ~ -10 | +35 ~ +60 |
| 开发脚本 | 无 | +0 | -0 | 0 |
| 文档 | `docs/account-management.md`、本问题单修复记录 | +15 ~ +25 | -5 ~ -10 | +10 ~ +20 |

### 验收标准

- [ ] `findWindowsCodexBinary()` 同时覆盖非重定向目录与 MSIX `Packages\OpenAI.Codex_*\LocalCache\Local\OpenAI\Codex\bin\<hash>\codex.exe` 并选取最新副本；包已安装但尚未初始化时给出首次打开桌面端提示。
- [ ] Windows 下 Codex 桌面端运行中点击「切换」可正常弹窗确认、自动安全退出桌面端（含其 `app-server` 子进程）、完成凭据切换并自动重新打开 Codex 桌面端；若同时存在独立终端 `codex` CLI 会话则仍按原保护拦截并恢复桌面端。
- [ ] Windows 下点击 Codex 当前账号卡片的「重启客户端」可正常关停并重开官方 Codex 桌面端。
- [ ] 单测与 UI 测试（`npm run lint`、`npm test`、`npm run test:ui`）全量通过，并在未安装 Node.js / 独立 CLI / IDE 插件的干净 Windows 环境配合商店版 Codex 桌面端完成双账号切换、查额与跨期续期真机验收。

## 3. 修复记录

- 2026-11-23，Windows 的额度查询和独立登录共用运行组件查找。保留显式配置、PATH 和 npm 的优先级，随后在普通缓存及官方商店包 LocalCache 中选最新的运行组件，兼容平铺目录和已完成的哈希目录。仅有包目录时提示打开或修复桌面端。
- GUI 确认关窗时核对之前观察到的进程，等待桌面及其 Codex 后台退出后应用账号，商店版按已注册入口重开。独立 CLI 或 PID 更换仍会保护当前登录。共用桌面逻辑和辅助程序的账目计入 AGS-0008。
- 使用合成 Mac 备份验证了 Windows 导入、切换、仅有商店缓存时查询，以及过期凭据经模拟官方 RPC 续期后同步到当前登录和账号池。另验证商店激活入口、常规与自定义安装、独立终端保护、重开失败和窗口恢复。README 中英文、账号管理流程和 Windows 待办均已同步。
- 按本单独占文件统计物理行数（基线／新增／删除／净增／修复后）。业务 810／80／55／25／835，测试 244／38／2／36／280，文档 392／16／8／8／400，脚本与配置均为 0。两个 README 计入本单，跨平台合用文件的增删只在 AGS-0008 统计一次。
- npm run lint、npm test（340 通过，5 项按环境跳过）、npm run test:ui（13 组）及 npm run site:build 通过。仅装商店桌面、两个真实测试账号的在线额度与跨期续期仍待独立 Windows 验收。

### 2026-11-23 Windows 桌面关窗返修

- 在 WMI 查询中先限定当前 Windows 会话，再核对用户。桌面主进程须能验证路径和归属，已确认属于它的沙箱子进程可以隐藏路径或 SID。通用名称 `language_server.exe` 需要官方安装路径佐证才会阻止切换。
- 窗口辅助程序以同步和有限查询权限打开进程，用 CIM 创建时间核对 PID，只向已确认的主进程窗口请求关闭。其余桌面子进程及 Codex 后台仅等待退出，对查询期间退出或 PID 更换的旧进程按已结束处理。
- 隔离模拟已覆盖子进程缺少元数据、PID 变化及第三方同名进程。Windows CI 的 Electron 回归用例改为启动多进程、两个窗口的桌面夹具，经过生产 `windowsDesktop()` 和 `quitWindowsDesktop()` 枚举与关窗。此用例须在 Windows 执行。桌面辅助程序已本地交叉编译。
- 本批 lint、单测（340 通过、0 失败、5 跳过）、13 组 UI 与站点构建全部通过。真实 Windows 多进程关窗、商店版重开及用户设备联调留待复验。
- 本轮物理行数账目（修前／新增／删除／净变化／修后）：业务 366／103／47／+56／422，测试 213／55／21／+34／247，文档 87／9／1／+8／95。脚本与配置无变更。

## 4. 验收记录

- **验收日期与环境**：2026-11-23（macOS 独立代码审查与自动化核验；干净 Windows 10/11 商店版 Codex 真机尚未联调）。
- **自动化验证结果**：`npm run lint`、`npm test`（340 通过 / 0 失败 / 5 环境跳过，含 `tests/codex-process.test.cjs`、`tests/windows-codex-portable.test.cjs`、`tests/windows-sessions.test.cjs`）、`npm run test:ui`（13 组通过）与 `npm run site:build` 均通过。
- **验收标准逐项核对**：
  1. **内置 `codex.exe` 发现与未初始化提示（验收标准 #1）—— 代码与单测通过**：
     - 核对 `src/windows-codex.ts`、`src/agents/codex.ts` 与 `src/codex-login.ts`：`CODEX_STORE_FAMILY = 'OpenAI.Codex_2p2nqsd0c76g0'` 经核对为微软商店官方 Codex 包族名；`findWindowsCodexBinary()` 保持显式配置 / PATH / npm（含 ARM64 仿真）优先级，兜底同时扫描 `%LOCALAPPDATA%\OpenAI\Codex\bin` 与 `Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\OpenAI\Codex\bin`（兼容平铺与 16 位十六进制哈希目录、跳过 `staging`）并取最新 `mtimeMs`；`missingWindowsCodexRuntime()` 接入额度查询与独立登录错误提示。
  2. **Codex 桌面端运行中切换关停/重开与「重启客户端」（验收标准 #2、#3）—— 存在阻断缺陷，退回修复**：
     - 商店版 `Get-AppxPackage` + `explorer.exe shell:AppsFolder\<PackageFamilyName>!<AppId>` 激活重开、后台 `codex.exe` 子进程树等待、以及独立终端会话拦截后自动恢复桌面端的主体编排逻辑清晰合理；
     - **但所依赖的共用底层存在两处实机阻断缺陷（详见 [AGS-0008](AGS-0008-windows-runtime-and-sandbox.md) 第 4 节第 3、4 项）**：
       1. `src/windows-desktop.ts:138` 将 Electron 全部进程（含 `--type=renderer` / `--type=gpu-process` / `--type=utility`）传给 `assets/windows/DesktopWindows.cs`，后者第 `32` 行通过 `.NET Process.Handle` 请求 `PROCESS_ALL_ACCESS`，遇 Chromium 沙箱子进程或瞬时退出子进程会抛未捕获的 `Win32Exception` 并返回 `1`，导致 Codex 桌面端关窗与「重启客户端」在发 `WM_CLOSE` 前即失败；
       2. `src/windows-processes.ts:22-43` 与 `src/windows-desktop.ts:31-39` 在普通权限下遇 Chromium AppContainer 子进程或另一登录会话的 `Codex.exe` / `ChatGPT.exe` 时，`GetOwnerSid` 返回 `ReturnValue = 2`（`ownerKnown: false` / `file: null`），直接抛出「无法确认 Windows Codex 桌面进程」阻断切换与重启；
       3. `tests/windows-sessions.test.cjs:184-213` 的 Windows CI 用例绕过了 `windowsDesktop`（`Get-CimInstance CreationDate`）与完整 Electron 子进程树，仅传单个主进程 PID 与 `Get-Process StartTime`，未能实测真实关窗路径。
  3. **干净 Windows 商店版 Codex 真机验收（验收标准 #4）—— 待修复后执行**：
     - 需在未安装 Node.js / 独立 CLI / IDE 插件的 Windows 10/11 真机上，安装 Microsoft Store 版 Codex 并完成双账号导入、切换（含运行中自动退出与重开）、重启客户端、查额与跨期续期验收。
- **验收结论**：**不通过，退回 `待修复`**（第 1 项内置 `codex.exe` 发现已达标，须随 AGS-0008 一并修复 `DesktopWindows.cs` / `windows-desktop.ts` / `windows-processes.ts` 与 Windows CI Electron 关窗用例后再进入复验与真机联调）。

### 二次独立复验 · 2026-11-24（源码与自动化通过，保持 `待验收` 待干净 Windows 实机终验）

- **返修代码与测试复核（通过）**：
  - [assets/windows/DesktopWindows.cs](../assets/windows/DesktopWindows.cs)、[src/windows-desktop.ts](../src/windows-desktop.ts) 与 [src/windows-processes.ts](../src/windows-processes.ts) 已按要求改为 `SessionId` 当前会话过滤、`OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION)` 最小权限句柄固定、仅对 `rootProcesses`（校验 `parent.created < child.created` 防旧 PID 借用）发送 `WM_CLOSE`，其余 Electron 渲染/工具子进程与 `codex` 后台子进程全部走 `wait:` 退净等待（含受保护沙箱子进程轮询兜底）；
  - [tests/windows-sessions.test.cjs](../tests/windows-sessions.test.cjs) 第 `190-247` 行已升级为拉起含 2 个 `sandbox: true` 窗口的真实多进程 Electron 桌面夹具，完整经过生产 `windowsDesktop('Codex')`（`Get-CimInstance CreationDate`）、`runningWindowsClients('Codex')` 与 `quitWindowsDesktop('Codex')` 验证仅主进程收 `window:`、渲染子进程全走 `wait:`；
  - `npm run lint`、`npm test`（340 通过 / 0 失败 / 5 环境跳过）、`npm run test:ui`（13 组全过）与 `npm run site:build` 全部通过。
- **待干净 Windows 设备终验项（完成后即可关闭本单）**：
  - 在未安装 Node.js / 独立 CLI / IDE 插件的干净 Windows 10/11 环境安装 Microsoft Store 版 Codex 桌面端，验证首次未打开时的初始化提示、打开后双账号导入与运行中「切换」（自动关停桌面及后台 `codex.exe` 并经 `shell:AppsFolder` 重开）、「重启客户端」按钮，以及在线额度查询与过期续期写回。
