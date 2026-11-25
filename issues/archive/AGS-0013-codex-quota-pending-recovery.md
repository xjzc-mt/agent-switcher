# AGS-0013 · Codex 有效期内只读优先查额与挂起临时目录自动对账自愈

- 状态：已关闭
- 发现日期：2026-11-24
- 平台：全平台（Codex）
- 来源：本地真机实测（用户刷新 `1号池-8慢` 触发未确认写回硬拦截报错，排查发现同机共 3 个账号因此挂起）

## 1. 现象与复现

1. 后台或手动刷新 Codex 账号额度期间（此时账号 `access_token` 仍有数天有效期，并未触发续期），退出或重启 AGS（如开发态重启或关闭进程，后台只读额度查询本身不阻塞应用退出）。
2. 重启后再次刷新、切换或操作该账号（如 `1号池-8慢`、`2号池-3`、`2号池-5`）。
3. **实际结果**：顶部弹出错误提示 `同一登录上次查询的凭据尚未确认写回，已停止再次续期。恢复副本位于 /var/folders/.../ags-quota-xxxx，请保留该目录或重新登录`，账号永久卡住无法刷新，迫使用户逐个重新走浏览器授权登录。本机只读指纹核对证实：这 3 个残留临时目录的原进程与子进程组均已退出，且目录内 `auth.json` 与池内凭据字节 **100% 完全一致**（根本未发生过令牌轮换）。
4. **预期结果**：
   - 日常 `access_token` 尚在有效期内时，优先使用无 `refresh_token` 的只读副本查额度，从源头避免产生 `pendingCommit` 挂起目录；
   - 即使在真正续期途中遭遇进程中断留下 `ags-quota-*` 目录，下次操作时一旦确认原进程与子进程组均已退出，应自动完成对账恢复（已轮换且身份一致则安全采纳写回；未轮换则自动回收残留目录并继续），无需用户手动翻找临时目录或重新登录。

## 2. 根因与修复方案

### 根因定位
1. **有效期内过早暴露续期令牌并登记挂起**：[src/agents/codex.ts](../../src/agents/codex.ts) 第 `396-399` 行在 `allowRefresh` 为真时，未判断 `access_token` 是否仍在有效期内，无条件将真实 `refresh_token` 写入临时目录并调用 `markTemporaryCredentialsPending`（置 `pendingCommit: true`）。而后台刷新仅在写回阶段进入 `criticalCommitTracker`，子进程查询中途退出 AGS 即会遗留 `pendingCommit: true` 的临时目录。
2. **缺少自动对账恢复闭环**：Antigravity 已实现 `recoverAntigravityQuota` 自动恢复（[src/antigravity-quota-recovery.ts](../../src/antigravity-quota-recovery.ts)），但 Codex 在 [src/temporary-credentials.ts](../../src/temporary-credentials.ts) 第 `485-486` 行遇到同 `(identity, refreshInput)` 的历史 `pendingCommit` 目录时直接硬抛错拦截，且未向 `markTemporaryCredentialsPending` 传入 `original` 字节摘要，导致已退出的无变化副本和已轮换的有效新副本均无法自动收尾。

### 修复方案
1. **源头防呆：有效期内优先只读查额度**：
   - 在 [src/agents/codex.ts](../../src/agents/codex.ts) `queryCredential`（普通查额路径，非 `verifyTarget` 换票验证且 `!requiresBinding`）中，当 `access_token` 带有明确 `exp` 且距离过期仍有充足缓冲（如 `accessExp * 1000 > Date.now() + 60_000`）时，优先走现有的只读无续期分支（`refresh_token: 'ags-refresh-disabled'`、`0400` 权限、不调用 `markTemporaryCredentialsPending`）。
   - 仅当 `access_token` 已过期/临近过期（或无 `exp`），或只读查询明确返回鉴权拒绝（`authentication-rejected` / `account-unavailable`）且当前允许续期（在 [src/accounts.ts](../../src/accounts.ts) 或锁内复核未与运行中客户端共用凭据、池内版本未变）时，才升级执行带真实 `refresh_token` 的续期查询，并在 `markTemporaryCredentialsPending` 中一并传入 `original` 字节以便精确比对。
2. **中断残留 `ags-quota-*` 目录自动对账恢复（兼容已有历史残留目录）**：
   - 在同一身份锁与账号池锁保护下（接入刷新、切换 `preparedProfileCredentials` 等入口，或在 Codex 续期前统一对账），检查匹配当前 `(identity, refresh_token)` 的 `ags-quota-*` 挂起目录（注意兼容历史 `.ags-temporary-owner.json` 无 `inputDigest` 字段的旧记录）：
     - **原进程或子进程组仍在运行**（`ownerStillRunning || writersRemain`）：保留目录不动，返回瞬时等待提示（`上次额度查询仍在处理凭据，请稍后刷新`），不标为失效、不要求重登；
     - **原进程与子进程组均已退出**：安全读取该临时目录下的 `auth.json`（校验当前用户 UID 归属、普通文件、无符号链接及安全权限）：
       1. **未发生轮换**（`auth.json` 不存在，或字节与池内原凭据相同，或 `refresh_token` 与 `access_token` 均未变化——覆盖本机现有的 3 个残留目录）：直接安全清理并回收该残留临时目录（跨进程回收须在校验 `!ownerStillRunning && !writersRemain` 后清除目录），正常继续本次查询/续期；若极端情况下服务端此前已消耗旧令牌，本次请求会自然收到官方 `refresh-reused` 并归入 `凭据失效`，不产生死锁；
       2. **已发生合法轮换**（`auth.json` 已更新，解析有效且通过 `sameRefreshedIdentity`、邮箱与工作区/令牌对一致性校验）：自动将该新凭据原子写回账号池对应账号（并同步同版本副本），校验落盘一致后清理该临时目录，使用恢复后的新凭据继续后续操作；
       3. **已轮换但身份或工作区冲突**：保留临时目录作恢复取证，沿用既有 `consumedRotation` 冲突保护提示。
3. **冗余与死代码清理**：
   - 核查 [src/temporary-credentials.ts](../../src/temporary-credentials.ts) 与 [src/accounts.ts](../../src/accounts.ts) 中旧的硬编码拦截文案及是否仍有重复的未确认恢复分支，保持实现精简直接，不留不可达分支。

### 边界约束（不做什么）
- 不放宽身份与工作区冲突保护（串号或跨工作区轮换仍必须拦截并保留原凭据）。
- 客户端正在运行且共用同一份登录时，继续严格保持只读保护，不抢跑客户端续期。
- 不另造跨平台重型抽象框架；仅按 Codex 文件凭据的实际结构补齐最小对账恢复与只读优先逻辑。

### 代码量基线与预估（物理行数）

| 类别 | 相关文件基线 | 预计新增 | 预计删除 | 预计净变化 |
| --- | --- | --- | --- | --- |
| 业务源码 | `src/agents/codex.ts` (604)、`src/temporary-credentials.ts` (592)、`src/accounts.ts` (1,521) | +70 ~ +105 | -15 ~ -30 | +50 ~ +80 |
| 测试 | `tests/temporary-credentials.test.cjs` (235)、`tests/codex-query-identity.test.cjs` (252) | +55 ~ +85 | -5 ~ -20 | +45 ~ +70 |
| 文档 | `docs/refresh-behavior.md` (80)、`docs/account-management.md` (335)、本问题单、`issues/README.md` | +20 ~ +35 | -5 ~ -15 | +10 ~ +25 |

### 验收清单
- [x] `access_token` 仍在有效期内（`> 60s`）的 Codex 常规查额度全程使用无真实 `refresh_token` 的只读临时副本，查询中途强杀进程不会留下任何 `pendingCommit: true` 目录。
- [x] `access_token` 已过期或只读查询遭鉴权拒绝时，在允许续期的条件下能自动升级为带续期的查询并正常写回新令牌。
- [x] 模拟历史遗留（无 `inputDigest`）及新版中断留下的已退出 `ags-quota-*` 目录：① `auth.json` 未变化时自动清理目录并成功完成刷新/切换（覆盖本机 3 个卡住账号的真实形态）；② `auth.json` 已合法轮换时自动采纳写回账号池并清理目录；③ 轮换后身份/工作区冲突时仍保留目录并告警；④ 原进程仍存活时不误删。
- [x] 检查无冗余死代码残留，`npm run lint`、`npm test`、`npm run test:ui` 与 `npm run site:build` 全部通过，同步更新 [docs/refresh-behavior.md](../../docs/refresh-behavior.md) 与 [docs/account-management.md](../../docs/account-management.md)。

## 3. 修复记录

- 2026-11-24。已绑定身份的 Codex 普通查额，访问令牌剩余超过 60 秒时使用无真实续期令牌的只读副本。临近到期或缺少有效期时按既有续期权限查询。只读请求明确遭拒后，先重新确认共用客户端、池内版本和候选凭据，再决定是否换票一次。
- 刷新、准备切换与导出在身份锁和池锁内核对挂起目录，兼容无输入摘要的历史记录。未轮换直接清理；合法轮换先记录输出摘要，逐份写回同代副本并复读。恢复补齐用户身份时，后续操作重新取得对应身份锁；其他工作区、较新登录及外部待验证凭据均受原保护。
- 已用隔离账号池覆盖强杀只读查询、鉴权拒绝与客户端占用、活跃写入者、旧版未轮换副本、同令牌不同序列化、缺少输出、身份冲突、权限异常，以及别名写回中断后从已更新副本继续。Windows 私有目录与文件的所有者和 ACL 校验已编译。Windows 同次开机的旧记录若只有直接子进程 PID，仍保留到可证明写入者全部退出；原生行为待 Windows 复验。
- 全项目隔离自测通过 lint、单测（347 通过、5 项依环境跳过、0 失败）、13 组 Electron UI 与站点构建。已同步账号管理及额度刷新文档。
- 按本单涉及文件统计物理行（修前／新增／删除／净变化／修后），共享文件仅计本单改动。业务 3,119／310／89／+221／3,340，测试 1,747／158／13／+145／1,892，文档 533／16／5／+11／544。开发脚本与配置增删均为 0。 业务和测试增量高于单据初估，主要用于区分存活写入者、安全核验私有文件、在已部分写回后续接，以及用进程中断验证这些路径。

## 4. 验收记录

- **验收日期与结论**：2026-11-24，**全部安全边界、历史残留兼容与死代码清理核验通过，准予关闭归档**。
- **独立复核要点**：
  1. **只读优先与按需升级**：[src/agents/codex.ts](../../src/agents/codex.ts) 在已绑定身份且 `access_token` 剩余有效期 `> 60s` 时走无真实 `refresh_token` 的 `0400` 只读分支（不登记 `pendingCommit`）；仅当临近/已过期或只读返回鉴权拒绝，并在 [src/accounts.ts](../../src/accounts.ts) 内重检未与运行中客户端共用、池内版本与待验证文件未变后才单次换票。
  2. **本机真实残留目录兼容对账**：核对了本机 `/var/folders/.../ags-quota-*` 现有的 3 个残留目录（目录 `0700`、文件 `0600`、无 `inputDigest` 且字节未变），[src/codex-quota-recovery.ts](../../src/codex-quota-recovery.ts) 与 [src/temporary-credentials.ts](../../src/temporary-credentials.ts) `pendingCodexQuota` 在确认原进程与子进程组均已退出后直接回收清理，合法轮换则按身份与工作区核对写回同代副本，工作区或身份冲突仍转入 `ConsumedCodexRotation` 隔离保留。
  3. **无死代码残留**：旧 `allowUnchangedTemporaryRefresh` 及硬编码未确认写回抛错分支已同步移除，新增导出符号均有明确调用方。
  4. **自动化回归**：`npm run lint`、`npm test`（347 通过 / 0 失败 / 5 跳过）、`npm run test:ui`（13 组全绿）、`npm run site:build` 全部通过。
