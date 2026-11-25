# AGS-0005 · 账号池跨锁并发竞态、孤儿明文临时目录残留与 Linux 密钥误报

- 状态：已关闭
- 类型：并发与安全卫生缺陷
- 来源：2026-11-23 全量质检
- 环境：跨平台核心层（macOS / Linux / Windows 共用账号池逻辑，及 Linux `secret-tool` 终端环境）

## 1. 现象与复现

1. **后台刷新期间更新或导入凭据引发假冲突**：后台正在对某 Antigravity 账号执行 `refreshAccount` 时，用户对该账号完成「更新 → 重新登录」或导入备份覆盖，写操作不等刷新结束即改写池内凭据，随后在途刷新收尾报错 `PendingQuotaConflict` 或续期冲突。
2. **重登更新或删号后明文临时目录永久残留**：某次刷新中断留下 `pendingCommit: true` 的 `$TMPDIR/agent-switcher-<uid>/ags-*` 目录（含明文临时凭据）及池根目录 `.antigravity-quota-<hash>-*` 后，用户按提示重新登录更新或删除该账号，但上述池恢复文件与 `$TMPDIR` 明文临时目录跨重启仍永久留在磁盘上。
3. **外部凭据 `.pending` 验证落库后写本机失败误报状态**：候选凭据已通过官方验证覆盖账号池并删掉 `.pending`，若随后同步写 `agent.homeDir` 抛错，不仅遗漏释放临时目录，前端还弹出反向误导提示「新凭据暂存验证未完成，原凭据已保留」。
4. **Linux SSH / 未解锁 Keyring 误报密钥已丢失**：在无 D-Bus 或未解锁密钥环的 Linux 终端运行 `ags`，已有加密账号池被误报「账号池密钥不存在，无法读取已有加密凭据；请恢复系统密钥或导入备份」。

## 2. 根因与修复方案

### 根因定位

1. **锁顺序与覆盖面不一致**：`refreshAccount`（[accounts.ts](../../src/accounts.ts) 第 `1198-1340` 行）在子进程执行期仅持有 `.quota-<identity>` 锁并释放全局 `.lock`；`useAccount` 与 `exportBackup` 走了 `withProfileCredentialLocks`（先 `.quota-<id>` 后 `.lock`），但 `saveAccount`（第 `397` 行）、`removeAccount`（第 `616` 行）、`updateAccountCredentials`（第 `738` 行）与 `installBackup`（[backup.ts](../../src/backup.ts) 第 `319` 行）仅获取了 `.lock`。
2. **孤儿恢复状态无终态清理入口**：[temporary-credentials.ts](../../src/temporary-credentials.ts) 第 `485` 行 `reapTemporaryCredentials()` 无条件跳过全部 `owner.pendingCommit === true` 目录，而 `replaceAccountCredentialsLocked(trusted: true)` 与 `removeAccount` 均未在确认无活跃写入进程后清理旧 `.antigravity-quota-*` 与对应临时目录。（同文件第 `342` 行 `pendingAntigravityQuota` 检查 `writersRemain` 时亦漏判了第 `485` 行已有的 `earlierWindowsBoot`。）
3. **两阶段提交错误透传不区分池落盘与本机同步**：[accounts.ts](../../src/accounts.ts) 第 `1087-1098` 行先落盘池凭据再写 `homeDir`，异常跳过 `releaseTemporaryCredentials`；[renderer/app.js](../../renderer/app.js) 第 `1460` 行对所有异常硬编码显示「原凭据已保留」。
4. **`secret-tool` 退出码歧义**：[credential-vault.ts](../../src/credential-vault.ts) 第 `198-200` 行将所有 `status === 1` 视为 `null`（密钥未创建），忽略了 `secret-tool` 在 D-Bus 缺失或通信失败时同样返回 `1` 但向 `stderr` 输出错误信息。

### 修复方案

1. **统一凭据写锁序**：将 `saveAccount`、`updateAccountCredentials`、`removeAccount`、`installBackup` 全部接入 `withProfileCredentialLocks`（对涉及身份先获取 `.quota-<id>` 再获取 `.lock`，提交前重检身份未漂移）。
2. **终态清理旧恢复记录与明文临时目录**：在持有 `.quota-<id>` 锁且 `!writersRemain(record)`（同时在 `writersRemain` 内部统一纳入 `earlierWindowsBoot` 判断）的前提下，当 `trusted: true` 官方重新登录成功替换池凭据，或删除最后一个同身份账号时，同步清理匹配的 `.antigravity-quota-<hash>-*` 及已无存活进程的 `pendingCommit` 临时目录。
3. **修正 `.pending` 验证落库后的本机同步异常处理**：池内正式凭据更新成功后，确保 `releaseTemporaryCredentials` 必被调用；若仅同步本机当前登录失败，返回池已更新但本机同步未完成的明确提示，引导用户点击切换应用。
4. **精确识别 Linux `secret-tool` 未创建状态**：仅当 `status === 1 && !String(error.stderr || '').trim()` 时返回 `null`，其余非零退出一律归入系统安全存储不可读错误并提示解锁系统密钥环。

### 边界约束（不做什么）

- 仍有存活子进程（`writersRemain === true`）或属于池内其他现存同身份账号的恢复目录严禁提前删除。
- Linux 系统安全存储不可用时保持拒绝写入，绝不降级明文保存。

### 代码量基线与预估

当前工作区物理行数基线：业务源码 69 文件 / 15,189 行，测试 58 文件 / 10,803 行，开发脚本 5 文件 / 451 行，文档 20 文件 / 1,736 行。

| 类别 | 预计涉及文件 | 预计新增 | 预计删除 | 预计净变化 |
| --- | --- | ---: | ---: | ---: |
| 业务源码 | `src/accounts.ts`、`src/backup.ts`、`src/temporary-credentials.ts`、`src/credential-vault.ts`、`renderer/app.js` | +70 ~ +105 | -25 ~ -40 | +40 ~ +70 |
| 测试 | `tests/refresh-coordination.test.cjs`、`tests/account-removal.test.cjs`、`tests/temporary-credentials.test.cjs`、`tests/credential-vault.test.cjs` | +80 ~ +120 | -10 ~ -20 | +65 ~ +105 |
| 开发脚本 | 无 | +0 | -0 | 0 |
| 文档 | `docs/account-management.md`、`issues/AGS-0005-credential-lock-and-temp-cleanup.md` | +15 ~ +30 | -5 ~ -10 | +10 ~ +20 |

### 验收标准

- [x] 模拟 Antigravity 账号刷新子进程在途时并发执行 `updateAccountCredentials`、`saveAccount`、`installBackup`，写操作严格排队等待 `.quota-<id>` 释放，不产生假阳性 `PendingQuotaConflict`。
- [x] 构造中断残留的 `.antigravity-quota-*` 与已退出进程的 `pendingCommit` 临时目录，执行官方重新登录更新或删除账号后，上述文件与明文临时目录均被清理干净；有存活写入进程时仍受保护保留。
- [x] `.pending` 验证成功写池后模拟写 `homeDir` 失败，临时目录正常释放且前端准确提示池已更新、本机待切换生效。
- [x] 模拟 Linux `secret-tool` 返回 `status=1` 且带 `stderr` 错误时，报错为「无法读取系统安全存储中的账号池密钥」而非「密钥不存在」。

## 3. 修复记录

2026-11-23，源码自测。

- 已确认保存、凭据更新与备份安装存在锁顺序缺口。删除账号原本已先锁身份，本次复用统一入口。涉及多个身份时按固定顺序取得额度锁，再在账号池写锁内读取并核对身份与版本。身份锁等待上限覆盖官方 CLI 在途时间。
- 可信重登及最终删除只回收能够归属旧登录、写入进程已结束的恢复文件和目录。存在同身份保留项、未知文件或活跃写入者时保留现场。候选凭据提交账号池后，如写当前客户端失败，释放已提交的临时结果并提示从账号池切换生效。
- Linux `secret-tool` 只有退出码 1 且标准错误为空才表示密钥缺失。有错误输出时停止写入并返回系统安全存储不可读。
- 隔离自测覆盖刷新在途时并发保存、更新、备份安装，恢复目录的回收与保留，以及写池成功后写客户端失败。复核另发现同名位置在排队时被不同身份重用的竞态。新回归在修复前失败，修复后旧任务在锁内退出，对新账号发出零次查询，其候选凭据仍可验证。流程变化已写入《账号管理流程》。

以本轮实际工作区为起点，四单共享文件按功能分摊后按编号对账。统计物理行，含空行和注释；配置单列。

| 类别 | 阶段前 | 新增 | 删除 | 净变化 | 阶段后 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 业务源码 | 15,355 | 197 | 101 | +96 | 15,451 |
| 测试 | 10,912 | 132 | 3 | +129 | 11,041 |
| 开发脚本 | 451 | 0 | 0 | +0 | 451 |
| 文档 | 2,062 | 22 | 5 | +17 | 2,079 |
| 配置 | 165 | 0 | 0 | +0 | 165 |

全量隔离自测：`npm run lint`、`npm test`、`npm run test:ui`、`npm run site:build` 通过。单测共 339 项，335 项通过，4 项仅适用于 Windows 或独立 macOS 用户的用例跳过，界面 13 套通过。

## 4. 验收记录

**2026-11-23 独立质检复核通过，问题关闭。**

- **代码与边界复核**：
  1. `saveAccount`、`removeAccount`、`updateAccountCredentials` 与 `installBackup`（传入全部目标 `entries` 身份 ID 列表并在锁内重验 `lockedIds.has(identity.id)`）已统一遵循 `.quota-<id>` → `.lock` 锁序；`withStoreLock` 对身份锁配置 5 分钟等待窗口覆盖在途 CLI 续期；`verifyStagedProfileCredential` 同步补齐了排队期间同名槽位换绑其他身份的 `lockedIdentity` 校验。
  2. `discardUnusedQuota` / `discardSupersededQuota` 在确认池内无其他同身份副本或未读损坏目录、且 `!writersRemain(owner)` 时回收已被取代旧令牌对应的 `pendingCommit` 临时目录及已排空的 `.antigravity-quota-*` 文件，不触碰活跃子进程或归属不明目录。
  3. `verifyStagedProfileCredential` 在池提交后的 `finally` 块稳定释放 `query.temporaryDirectory`，本机同步延迟或失败时写入 `committedStatus.extra = pendingClientSync`，前端 `app.js` 按 `warn` 准确提示切换生效。
  4. `credential-vault.ts` Linux 分支已严格限定 `failure.status === 1 && !String(failure.stderr || '').trim()` 才视为密钥未创建。
- **独立验证结果**：实跑 `npm run lint`、`npm test`（335 通过 / 0 失败）、`npm run test:ui`（13 套全过）全部通过。
