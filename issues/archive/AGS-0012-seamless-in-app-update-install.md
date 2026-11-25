# AGS-0012 · 应用内更新下载完成后自动安全退出、安装与重启

- 状态：已关闭
- 发现日期：2026-11-24
- 平台：macOS（Apple Silicon / Intel）、Windows x64
- 来源：local（内部产品体验优化）

## 1. 现象与复现

1. 在「设置 → 应用与更新」检测到新版本并完成下载与签名校验。
2. **实际结果**：[renderer/app.js](../../renderer/app.js) 第 `583-584`、`644-646` 行要求用户先点击「打开安装包」，随后按钮切换为「退出 AgentSwitcher」，用户还必须再手动退出应用才能完成替换或安装，交互割裂反直觉。
3. **预期结果**：安装包校验通过后提供一键 **「立即安装并重启」**（在不满足自替换条件的 macOS 环境自动降级为 **「打开安装并退出」**），由程序先通过 `quitGuard` 安全排空在途凭据轮换，再自动退出并完成更新拉起，无需用户手动二次退出。

## 2. 根因与修复方案

### 根因定位
1. **前端与主进程将「打开安装包」与「退出应用」拆成两步独立 IPC**：`open-app-update` 仅执行 `shell.openPath(file)`，`quit-for-app-update` 才执行 `app.quit()`（[src/main.ts](../../src/main.ts) 第 `285-287` 行）。
2. **缺少跨平台安装交接层**：Windows NSIS 安装包已具备覆盖安装能力但未做退出交接；macOS 因采用内置 Ed25519 公钥验签 + ad-hoc 签名（无付费 Apple Developer ID 证书，无法使用 `Squirrel.Mac`），尚未实现基于已验签 DMG 的本地应用包替换或一键打开并退出降级。

### 修复方案
1. **严格绑定 `quitGuard` 安全退出栅栏（最高优先级红线）**：
   - 点击更新安装动作时，绝不能先拉起外部替换脚本再调 `app.quit()`——否则若 `before-quit` 中用户因未保存登录/导入草稿点击「暂不退出」，会导致应用未退却已在后台覆盖文件！
   - 正确时序：① 先在主进程复验已下载安装包的签名清单与 SHA-256，并将待执行的安装制品复制到当前用户专属 `0700` 私有暂存目录（防止 `~/Downloads` 下的文件在验签后至执行前发生 TOCTOU 篡改）；② 标记 `pendingUpdateHandoff` 并触发 `app.quit()`；③ 在 `before-quit` 中若用户取消退出则清除 `pendingUpdateHandoff` 并清理暂存；**仅当 `quitGuard.request()` 返回 `{ ready: true }`（所有在途令牌续期与账号池写锁已安全落盘）后，在进程真正退出前最后一刻启动分离式（`detached: true, stdio: 'ignore'`, `unref()`）更新交接动作**。
2. **Windows x64：一键静默替换并自动重启**：
   - 在 `quitGuard` 放行后，从私有暂存路径分离拉起已验签的 NSIS 安装程序（支持静默更新参数如 `/S` 并在替换完成后重新启动新版 `AgentSwitcher.exe`，或脱离旧进程句柄无冲突安装），旧进程随即退出。
3. **macOS：`/Applications` 后台自替换重开 + 无权限平滑降级**：
   - **优先路径（自替换并重启）**：当打包态应用当前运行于 `/Applications/AgentSwitcher.app`（或用户可写的原 `.app` 捆绑包路径，排除 `/Volumes/...` 与 App Translocation 只读路径）且目标目录与 `.app` 具备写权限时：
     - 退出前在私有 `0700` 挂载点静默只读挂载已通过内置 Ed25519 公钥 + SHA-256 强校验的 `.dmg`（`hdiutil attach -nobrowse -readonly -mountpoint ...`），确认卷内存在 `AgentSwitcher.app`；
     - `quitGuard` 放行后拉起分离式 POSIX shell 更新辅助进程：等待原 PID 完全退出 → 使用 `ditto` 将新包先写入同目录临时 `.app` 并清理下载来源附加的 `com.apple.quarantine`（仅限已通过内置 Ed25519 签名校验的挂载源）→ 原子替换原 `AgentSwitcher.app`（失败时保留原包）→ `hdiutil detach` 卸载并清理私有目录 → `open` 重新启动新版应用。
   - **自动降级路径（一键「打开安装并退出」）**：开发态、从挂载卷直接运行、或 `/Applications` 当前用户无写权限时，不弹提权密码框骚扰用户，自动采用一键交接：`quitGuard` 放行后调用 `shell.openPath(verifiedDmg)` 打开挂载窗口并立即退出旧进程，界面按钮与提示文案如实对应（「立即安装并重启」vs「打开安装并退出」）。

### 边界约束（不做什么）
- 不引入 `electron-updater` 等第三方重依赖，保持零额外运行时依赖与现有 Ed25519 发布签名体系。
- 不绕过 `quitGuard` 强行 `process.exit()`，不修改系统全局安全策略。

### 代码量基线与预估（物理行数）

| 类别 | 相关文件基线 | 预计新增 | 预计删除 | 预计净变化 |
| --- | --- | --- | --- | --- |
| 业务源码 | `src/app-updates.ts` (330)、`src/main.ts` (624)、`src/preload.ts` (57)、`renderer/app.js` (1,742) | +85 ~ +135 | -20 ~ -35 | +60 ~ +105 |
| 测试 | `tests/ui-app-updates.cjs` (142) 及更新交接单元测试 | +60 ~ +100 | -10 ~ -25 | +50 ~ +80 |
| 文档 | `docs/app-updates.md` (34)、`docs/ui-design.md` (140)、本问题单、`issues/README.md` | +20 ~ +35 | -10 ~ -20 | +10 ~ +20 |

### 验收清单
- [x] 下载校验完成后不再出现「先点打开安装包、再手动点退出」的两步接力；可自替换环境显示一键「立即安装并重启」，macOS 只读/非标准目录环境自动显示并执行「打开安装并退出」。
- [x] 当存在未保存登录/导入草稿且用户在退出确认弹窗点击「暂不退出」时，不会提前拉起安装器或覆盖应用；当存在在途凭据刷新时，必先等待 `quitGuard` 回存完成后再执行交接。
- [x] 校验失败或文件被篡改时拒绝启动交接并提示重新下载；私有暂存防住 `~/Downloads` TOCTOU。
- [x] 隔离自动化测试覆盖 Windows 交接参数、macOS 自替换脚本原子替换/回退、取消退出中断交接及 UI 面板状态流转；`npm run lint`、`npm test`、`npm run test:ui`、`npm run site:build` 全部通过，同步更新 [docs/app-updates.md](../../docs/app-updates.md) 与 [docs/ui-design.md](../../docs/ui-design.md)。

## 3. 修复记录

- 2026-11-24。安装入口复验签名清单，只交接 SHA-256 和大小均匹配的私有副本。macOS 暂存目录权限为 `0700`，Windows 使用仅授权当前用户的 ACL。取消退出会卸载并删除已准备的暂存；在账号写入和续期回存结束前不能启动交接。安装失败时，已下载文件变动与已签名镜像结构损坏分别处理。
- 当前可写的 macOS 安装位置采用只读挂载、同卷原子交换和重开失败回滚。需手动替换时显示「打开安装并退出」，系统继续使用私有临时镜像。Windows 交接等待旧进程退出，调用 NSIS 静默安装并请求重开。已同步《应用内下载更新》《界面设计约定》《账号管理流程》。
- 本机隔离实跑合成 DMG 的取消、原子替换、回滚和卸载，使用替身接收应用打开请求。退出测试覆盖待保存凭据、草稿取消、重复退出与延迟交接。Windows 已核对暂存及 NSIS 参数，真实安装重启留待 Windows 复验。全项目 lint、单测（344 通过、5 项依赖专用环境跳过、0 失败）、13 组 UI 与站点构建通过。
- 按本单涉及文件统计物理行（修前／新增／删除／净变化／修后），共享文件只计本单的改动。业务 2,914／269／54／+215／3,129，测试 866／174／40／+134／1,000，文档 619／20／11／+9／628。脚本及配置均无变更。 验证真实 DMG、暂存清理及退出写回时序所需的业务和测试增量高于单据初估。

### 2026-11-24 返修

- Windows 改由 `System.Diagnostics.Process.Start` 启动并持有 NSIS 句柄，直接读取安装器退出码。成功交由 NSIS 打开新版，启动失败或退出码非零才尝试重开原程序。释放句柄后清理私有暂存目录，遇占用每隔 250 毫秒重试，最多删除四次。
- 已在既有 Windows CI 用例中加入即时退出的模拟安装器和临时文件占用，区分退出码 0 与 7 的重开行为并检查清理结果。本机 macOS 通过 Mono 验证即时退出码读回；Windows PowerShell 5.1 原生脚本与正式 NSIS 升级留待 Windows 复验。
- 隔离自测通过 lint、单测（342 通过，5 项因环境跳过）、13 组 Electron UI 与站点构建。设置页滚动用例在原生点击后等待更新说明实际展开，再检查滚动位置。
- 本单涉及文件物理行数（修前／新增／删除／净变化／修后），共享总览仅计本单修改。业务 139／10／2／+8／147，测试 653／21／1／+20／673，文档 163／10／3／+7／170。脚本和配置增删均为 0。

## 4. 验收记录

- **验收日期与结论**：2026-11-24，**macOS 原子替换链路、安全栅栏与旧两步死代码清理均达标，但检出 Windows PowerShell 5.1 退出码误判缺陷，退回 `待修复`**。
- **已验证通过项**：
  - 旧两步更新遗留代码（`open-app-update`、`quit-for-app-update`、`appUpdateOpenedVersion` 及双按钮状态分支）已 100% 清理无残留；
  - `prepareInstall` 复验 Ed25519 签名清单 + `O_NOFOLLOW` 复制至 `0700`/单用户 ACL 私有目录再验 SHA-256，防住 `~/Downloads` TOCTOU；
  - `quitGuard.installUpdate` 与 `finishQuit` 严格保证未保存草稿点击「继续使用」时自动卸载清理暂存、在途 `trackCritical` 令牌轮换落盘前绝不提前交接；
  - macOS 26 实机探测验证 `fs.realpathSync('/Applications') === '/Applications'`，且 JXA `renamex_np(..., 2)`（`RENAME_SWAP`）同卷原子交换、打开失败自动回滚与只读挂载清理全部正常。
- **退回修改项（须在关闭前完成）**：
  1. **【P1 · Windows PowerShell 5.1 `Start-Process -PassThru` 未缓存 `.Handle` 导致 `$installer.ExitCode` 为 `$null` 必现误判失败】**：
     - 位置：[src/update-handoff.ts](../../src/update-handoff.ts) 第 `60-67` 行（运行于 `WindowsPowerShell\v1.0\powershell.exe`）。
     - 根因：不用 `-Wait` 是正确的（`-Wait` 会通过 Job Object 连带等待 `--force-run` 拉起的新版 `AgentSwitcher.exe` 退出而永久挂起），但在 Windows PowerShell 5.1 中，`Start-Process ... -PassThru` 若未在子进程退出前读取缓存 `$installer.Handle`，调用 `$installer.WaitForExit()` 后 `$installer.ExitCode` 会返回 `$null`。PowerShell 中 `$null -ne 0` 为 `$true`，会导致每次 NSIS 静默更新成功（实际退出码 `0` 且已拉起新版）后都抛 `'Installation failed'` 进入 `catch` 再次启动 `$env:AGS_ORIGINAL_APP`。同时 `finally` 的 `Remove-Item` 缺少容错，若 Windows 杀软短暂持有刚退出安装器句柄会报错退出。
     - 修复要求：启动后判空 `$installer` 并立即缓存句柄（如 `try { $null = $installer.Handle } catch {}`，或直接用 `System.Diagnostics.Process` 显式持有句柄启动等待）使 `.ExitCode` 可靠返回整型退出码；`finally` 删除暂存目录补充短暂重试与 `-ErrorAction SilentlyContinue`，并补齐对应单测断言。

### 2026-11-24 返修独立复验
- **复验结论**：**返修项与验收清单全部核验通过，准予关闭归档**（Windows 正式发行包 NSIS 覆盖安装随下一版发布验收例行核对）。
- **逐项核对**：
  1. [src/update-handoff.ts](../../src/update-handoff.ts) 第 `61-75` 行已改用 `[Diagnostics.Process]::Start($env:AGS_UPDATE_FILE, '/S --updated --force-run')` 直接持有原生进程句柄，即使安装器瞬时退出也能可靠读取整型 `ExitCode`；`finally` 先释放 `$installer.Dispose()` 再对私有暂存目录做最多 4 次（间隔 `250ms`）容错删除；
  2. [tests/app-updates.test.cjs](../../tests/app-updates.test.cjs) 第 `306-322` 行已补入 Windows 真实 `powershell.exe` 瞬时退出码（`0` vs `7`）与文件锁占用重试断言。
- **自动化验证**：`npm run lint`、`npm test`（342 通过 / 0 失败 / 5 跳过）、`npm run test:ui`（13 组全绿）、`npm run site:build` 全部通过。
