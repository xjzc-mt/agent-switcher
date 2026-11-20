# AGS-0001 · Antigravity 检测到 CLI 认证文件后无法保存当前账号或切换账号

- 状态：待验收
- 类型：兼容性缺陷
- 来源：2026-11-19 客户反馈
- 环境：macOS。已核对当前工作区源码与本机官方 Antigravity App 2.32.1（`language_server`）/ `agy` CLI 1.5.9；客户的具体构建、macOS 及 Antigravity 版本待补充。

## 1. 现象与复现

1. 在 macOS 上使用 AGS 的 Antigravity 2.x 适配器。客户反馈的检查结果为 `~/.gemini/antigravity-cli/antigravity-oauth-token` 存在，`~/.gemini/jetski-standalone-oauth-token` 不存在。
2. 在官方客户端重新登录一个账号，再到 AGS 对备用账号点「切换」。
3. AGS 提示「检测到文件认证回退，暂不混用 Keychain 与文件认证」，目标账号没有生效。

[antigravity-native.ts](../src/antigravity-native.ts) 在读取钥匙串前检查这两个路径，任意一个存在即报错。这也一并阻断了面板当前账号展示、「保存当前账号」、切换时的「保存后切换」以及「同时退出当前客户端登录」。通过「Session 导入」将受支持的文件单独加入账号池是另一条操作路径，不能解除上述阻断。参考 [账号管理流程](../docs/account-management.md)。

现场已知与待确认事实：
- 客户环境已确认 `~/.gemini/antigravity-cli/antigravity-oauth-token` 存在、`~/.gemini/jetski-standalone-oauth-token` 不存在，尚未取回该文件内部结构（空壳、同账号旧凭据或另一账号凭据）及客户手动改名后的反馈。

## 2. 根因与修复方案

### 根因定位

1. **官方桌面端与 CLI 的复合存储路径不对称**：
   官方 `Antigravity.app`（`language_server`）与 `agy` CLI 共用 `compositeTokenStorage` 及 macOS Keychain（`service=gemini`, `account=antigravity`），但各自绑定的文件回退路径与 1 小时超时标记（按文件 `mtime < 3600s` 判定）不同：
   - 桌面端：`~/.gemini/jetski-standalone-oauth-token` 与 `~/.gemini/cache/antigravity-keyring-unavailable`
   - CLI：`~/.gemini/antigravity-cli/antigravity-oauth-token` 与 `~/.gemini/antigravity-cli/cache/antigravity-keyring-unavailable`
   当 `agy` 因 Keychain 瞬时超时、锁屏未解锁或本地 SSH 会话触发文件回退写出 `antigravity-oauth-token`（或 `/logout` 后保留无 token 的退出状态文件），后续用户在 `Antigravity.app` 桌面端重新登录新账号时，桌面端只会写入 Keychain 并清理它自己的 `jetski-standalone-oauth-token`，不会清理 CLI 目录下的 `antigravity-oauth-token`。而在无活跃超时标记时，桌面端完全不读 CLI 回退文件，`agy` 启动 `LoadStoredToken` 也优先读取 Keychain。
2. **AGS 在底层读取入口做了无条件文件存在阻断**：
   [antigravity-native.ts](../src/antigravity-native.ts) 的 `assertNativeStorageReady()` 对上述两个路径执行无条件 `fs.existsSync` 检查并直接抛错；`readNativeToken()` 被 `identity()`、`saveAccount()`、`useAccount()`、`writeNativeToken()` 共用，导致只要残留文件存在（哪怕是无凭据空壳、同账号旧副本或已被桌面端新登录取代的旧账号），整个 Antigravity 账号管理链路即全部报错锁死。

### 修复方案

将 Antigravity 2.x 适配从「要求无任何回退文件存在」调整为「按真实生效优先级解析身份 + 切换前保护未入池回退凭据 + 切换/退出时原子收敛清理」：

1. **回退文件分类与当前生效凭据解析（[src/antigravity-native.ts](../src/antigravity-native.ts)）**：
   - 去掉 `assertNativeStorageReady()` 中的无条件 `fs.existsSync` 抛错，改为检查本机认证面：Keychain、两个回退文件（`jetski-standalone-oauth-token`、`antigravity-cli/antigravity-oauth-token`）与两个 `*-keyring-unavailable` 标记（`mtime` 在 1 小时内视为活跃）。
   - 将单个回退文件内容分为四类：
     - `absent`：文件不存在；
     - `stub`：合法 JSON 对象但无 `refresh_token` / `access_token`（如 `/logout` 留下的退出状态），视为无活跃凭据；
     - `consumer`：通过 `parseNativeToken` 校验的个人 Google 账号凭据；
     - `blocked`：`auth_method !== 'consumer'` 的企业/GCP 凭据，或损坏、缺必要身份/续期字段的非空文件。
   - `readNativeToken()` 解析规则：
     - 若 Keychain 含有效个人凭据，且桌面端无活跃 `cache/antigravity-keyring-unavailable` 标记（或桌面回退文件无个人凭据）：以 Keychain 身份作为当前生效账号（即使某回退文件含另一账号或为 `blocked`，也不阻断读取当前账号与保存当前账号）；若任一回退文件存有**同一身份**且 `expiry` 更新的个人凭据，返回较新的凭据字节。若 Keychain 自身为非个人账号或损坏格式，保持现有报错。
     - 若桌面端有活跃超时标记且 `jetski-standalone-oauth-token` 含个人凭据，以该桌面回退凭据为当前生效账号（同身份取较新 `expiry`）。
     - 若 Keychain 为空：检查两个回退文件中的 `consumer` 凭据——仅一处存在或两处为同一身份时返回该凭据（取较新 `expiry`）；两处分别为不同个人账号时抛错说明「检测到桌面端与 CLI 认证文件分别为不同账号，请先导入备份或在官方客户端统一登录」；无个人凭据但存在 `blocked` 文件时按具体原因报错（非个人账号或凭据格式无效）；均无凭据（全为 `absent` / `stub`）时返回 `null`。

2. **切换前的附属回退凭据保护（[src/agents/base.ts](../src/agents/base.ts)、[src/agents/antigravity.ts](../src/agents/antigravity.ts)、[src/accounts.ts](../src/accounts.ts)）**：
   - 在 `BaseAgent` 增加最小可选方法（例如返回切换时将被收敛清理的附属有效凭据列表，默认空数组），由 `AntigravityAgent` 在 `nativeEnabled` 模式下返回回退文件中除当前主凭据外的有效 `consumer` 凭据。
   - 接入 `accounts.ts` 的 `needsUnmanagedChoice()` 与 `syncCurrent()`：
     - 回退文件中的个人账号**已在账号池中**时：按现有 `credentialOrder` 比较，仅当回退文件版本更新（`order === 'newer'`）时同步写回对应池记录，保留 CLI 侧可能发生过的续期轮换。
     - 回退文件中的个人账号**不在账号池中**（且异于当前主账号与目标切换账号）时：`needsUnmanagedChoice()` 同样返回 `true`，走既有「保存后切换 / 不保存并切换」（CLI：`--save-current` / `--discard-current`）显式确认——选保存则归档为 `backup-<timestamp>`，选不保存则直接丢弃，**不暗中把用户已移除的账号自动备份回池**。

3. **写入与退出的收敛清理及失败回滚（[src/antigravity-native.ts](../src/antigravity-native.ts)、[src/agents/antigravity.ts](../src/agents/antigravity.ts)、[src/client-logout.ts](../src/client-logout.ts)）**：
   - **显式切换账号（`AntigravityAgent.use`）**：
     - 前置保持 `sharedAntigravitySessions()` 与桌面端退出检查；若任一回退文件为 `blocked`（企业凭据或损坏文件），拒绝删除并报明具体文件路径与原因，保留全部原凭据。
     - 记录完整原状快照（原始 Keychain 字符串、两个回退文件内容、两个超时标记内容与存在状态），写入目标 Keychain 并回读校验通过后，清理两个回退文件与两个 `*-keyring-unavailable` 标记；任一步失败时按快照恢复 Keychain、回退文件与标记后再抛错。
   - **非切换的凭据更新（后台额度续期 `commitQuery`、失效凭据原位更新 `replaceAccountCredentialsLocked`）**：
     - 默认 `writeNativeToken(bytes)` 写入并校验 Keychain 后，**仅清理 `stub` 或与写入凭据同身份的回退文件**（以及无异号回退文件存在时的超时标记），绝不在后台刷新时误删回退文件中尚未处理的其他账号。
   - **客户端退出（`client-logout.ts` 与 `writeNativeToken(null)`）**：
     - 若回退文件中存在异号个人凭据或 `blocked` 文件，`logoutSupport` 返回具体原因拒绝自动退出，避免退出当前账号时误清另一份凭据或导致 CLI 退回另一账号；
     - 当回退文件均为空、`stub` 或与当前账号同身份时，删除 Keychain 项并一并清理回退文件与超时标记。

### 边界约束（不做什么）

- 不改动 [src/antigravity-cli.ts](../src/antigravity-cli.ts) 现有的独立临时 `HOME` + `sandbox-exec` 隔离登录与额度查询机制。
- 不支持切换企业/Google Cloud 账号（`auth_method !== 'consumer'`、ADC、API Key），也绝不静默覆盖或删除这类凭据文件。
- 不在用户未确认保存（`saveUnmanaged !== true`）时将未入池的回退文件凭据暗中写入账号池。
- 不引入跨平台抽象层或改动 Codex / Claude Code 的现有切换逻辑。

### 代码量基线与预估

以下基线按本方案落盘后的当前工作区物理行数统计（含空行和注释；排除 `node_modules`、`dist`、`release`、`test-results` 及锁文件）：

| 类别 | 当前全量基线 | 本次预计涉及文件（当前行数） | 预计新增 | 预计删除 | 预计净变化 |
| --- | --- | --- | --- | --- | --- |
| 业务源码 | 46 文件 / 7,626 行 | `src/antigravity-native.ts` (127)、`src/agents/antigravity.ts` (155)、`src/agents/base.ts` (124)、`src/accounts.ts` (638)、`src/client-logout.ts` (74) | +120 ~ +155 | -25 ~ -35 | +90 ~ +125 |
| 测试 | 44 文件 / 6,174 行 | `tests/antigravity-native.test.cjs` (157)、`tests/client-logout.test.cjs` (168) | +110 ~ +150 | -5 ~ -15 | +100 ~ +140 |
| 开发脚本 | 3 文件 / 295 行 | 无 | +0 | -0 | 0 |
| 文档 | 14 文件 / 908 行 | `docs/account-management.md` (178)、`issues/AGS-0001-antigravity-file-auth.md` (97) | +25 ~ +45 | -10 ~ -15 | +15 ~ +35 |

### 验收标准

- [ ] **主复现路径恢复（自动测试）**：Keychain 为账号 A，`~/.gemini/antigravity-cli/antigravity-oauth-token`（及 `jetski-standalone-oauth-token`）分别处于空壳、同账号旧/新版本、池内备用账号 B 时，均可正常识别当前账号 A、保存 A、切换到 B 并自动清除回退文件与 `*-keyring-unavailable` 标记，随后可再切回 A。
- [ ] **仅文件回退场景（自动测试）**：Keychain 为空、仅有单一回退文件（CLI 或桌面端）含个人账号 A 时，可识别并保存 A，切到 B 后写入 Keychain 并清理回退文件与超时标记；Keychain 为空且桌面与 CLI 文件分别为两个不同个人账号时，报明冲突原因并保留两份原文件。
- [ ] **未入池回退凭据保护与防暗中复活（自动测试）**：Keychain 为已入池账号 A、CLI 回退文件为未入池个人账号 X 时，切换触发 `needsUnmanagedChoice`；`saveUnmanaged: true` 将 X 保存为 `backup-*` 后清理回退文件，`saveUnmanaged: false` 清理回退文件且不把 X 重新加入账号池。
- [ ] **后台续期与异常回滚保护（自动测试）**：非切换的续期写回（`commitQuery`）不删除异号回退文件；企业凭据（`auth_method !== 'consumer'`）或损坏回退文件在切换与退出时均保留并报明原因；Keychain 写入或校验失败时，Keychain 与原回退文件、超时标记完整回滚。
- [ ] **客户端退出一致性（自动测试）**：回退文件为空、空壳或同身份时，`clearClientCredentials` 同时清 Keychain、回退文件与超时标记；存在异号或企业/损坏回退文件时，`logoutSupport` 拒绝自动退出并保留原凭据。
- [ ] **文档同步**：同步更新 [account-management.md](../docs/account-management.md) 中 Antigravity 的认证存储解析、切换收敛清理与退出边界说明。
- [ ] **真机端到端验收**：在 macOS 环境中分别验证「Keychain + CLI 回退文件并存」与「仅 CLI 回退文件」场景下，在 AGS 保存当前账号 A → 切到 B → 切回 A，重开 `Antigravity.app` 与 `agy` CLI 后均显示目标账号，全程无需手动改名或删除文件。

## 3. 修复记录

- 修复日期：2026-11-19

### 实际改动摘要

1. **回退文件分类、生效优先级与原子写入/回滚（[src/antigravity-native.ts](../src/antigravity-native.ts)）**：
   - 移除 `assertNativeStorageReady()` 对两处回退文件的无条件阻断；新增 `classifyFallback()` 将 `~/.gemini/jetski-standalone-oauth-token` 与 `~/.gemini/antigravity-cli/antigravity-oauth-token` 分类为 `absent`、`stub`、`consumer`、`blocked`（同时拒绝符号链接与非普通文件）。
   - `readNativeToken()` 按真实生效优先级解析：Keychain 异常/非个人格式保持原报错；桌面端存在 1 小时内活跃 `cache/antigravity-keyring-unavailable` 标记且桌面回退为 `consumer` 时优先桌面回退；否则 Keychain 有效时以 Keychain 为主；Keychain 为空时接受单一或同身份 `consumer` 回退，两处为不同个人账号时报错并保留原文件，仅有 `blocked` 时报明原因与路径，全为 `absent`/`stub` 时返回 `null`；同身份均取较新 `expiry`。
   - 新增 `readAuxiliaryNativeTokens(primaryId?)`（仅读取磁盘回退文件，不额外访问 Keychain，按身份去重取较新 `expiry`）与 `nativeLogoutSupport(primaryId?)`（复用 `fallbackLogoutConflict()`）。
   - `writeNativeToken(bytes, { clearFallbacks })` 支持 `'same'`（默认，供后台续期与原位更新：仅清 `stub` 与同身份回退文件，仅在无异号/阻塞回退时清超时标记）、`'all'`（显式切换：先拒绝任意 `blocked` 文件并报明路径与原因，再清全部两处回退文件与超时标记）及 `null`（客户端退出：拒绝异号/`blocked`/活跃标记与 Keychain 冲突，否则同时清 Keychain、回退文件与超时标记）。所有写入/退出前抓取 Keychain、两处回退文件与两处超时标记（含权限与 `mtime`）快照，Keychain 校验或文件清理任一步失败时完整回滚。
2. **附属回退凭据保护与切换接入（[src/agents/base.ts](../src/agents/base.ts)、[src/agents/antigravity.ts](../src/agents/antigravity.ts)、[src/accounts.ts](../src/accounts.ts)）**：
   - `BaseAgent` 新增 `auxiliaryCredentials()` 默认返回空数组；`AntigravityAgent` 在 `nativeEnabled` 模式下返回除当前主身份外的有效 `consumer` 回退凭据，并在 `use()` 显式切换时传 `{ clearFallbacks: 'all' }`。
   - `accounts.ts` 将 `auxiliaryCredentials()` 接入 `needsUnmanagedChoice()` 与 `syncCurrent()`：已入池回退账号仅在 `credentialOrder === 'newer'` 时同步写回对应池目录，并向 `useAccount()` 传递更新后的目标 revision 以避免误触 `CredentialChangedError`；未入池回退账号走显式 `saveUnmanaged` 确认（`true` 归档为不冲突的 `backup-<timestamp>`，`false` 不写入账号池）。
   - `useAccount()` 异常回滚块移除 `!applied && currentRevision === liveRevision` 的重复写回，避免切换因 `blocked` 文件或回滚中止时将原纯回退状态误写入 Keychain。
3. **客户端退出一致校验（[src/client-logout.ts](../src/client-logout.ts)）**：
   - `logoutSupport()` 对 macOS Keychain 模式 Antigravity 调用 `nativeLogoutSupport(agent.identity()?.id)`，捕获身份解析冲突或 `blocked`/异号回退文件并直接返回原因。
4. **自动化测试（[tests/antigravity-native.test.cjs](../tests/antigravity-native.test.cjs)、[tests/client-logout.test.cjs](../tests/client-logout.test.cjs)）**：
   - 补齐主复现路径（空壳、同身份旧/新、池内备用轮换、1 小时活跃/过期桌面标记）、仅文件回退（CLI/桌面单文件、同账号双文件、异号冲突、`blocked`、空壳）、未入池回退显式保存与丢弃防复活、后台 `commitQuery` 保留异号回退、`blocked` 拒切、Keychain 校验与 `unlinkSync` 失败全量回滚（含 `mtime`），以及 `logoutSupport`/`clearClientCredentials` 一致性测试。

### 偏离说明

- **功能边界无偏离**：严格按第 2 节实施，未改 `src/antigravity-cli.ts`、Codex / Claude Code 流程，未支持企业账号或暗中复活已移除账号。
- **代码量高于第 2 节预估**：
  - 业务源码净增 `+261` 行（预估 `+90 ~ +125`）：主要来自 `src/antigravity-native.ts` 完整实现四类回退分类（含符号链接/非普通文件防护）、Keychain/文件/超时标记 `mtime` 快照恢复、统一冲突校验与回读核验，以及 `src/accounts.ts` 中 `nextBackupName()` 去重和 `expectedTargetRevision` 保护。
  - 测试净增 `+292` 行（预估 `+100 ~ +140`）：包含独立隔离的 `withMockKeychain` 夹具及对 5 项自动化验收标准各边界分支的完整断言。
  - 注：开始修复前同口径复测当前工作区 `tests/` 基线为 `6,176` 行（较第 2 节表内 `6,174` 多 2 行），下表以本次开始前工作区实际基线统计。

### 实际代码量统计（同口径物理行数）

| 类别 | 涉及文件 | 实际新增 | 实际删除 | 净变化 | 改动前总量 | 改动后总量 |
| --- | --- | --- | --- | --- | --- | --- |
| 业务源码 | `src/antigravity-native.ts`、`src/agents/antigravity.ts`、`src/agents/base.ts`、`src/accounts.ts`、`src/client-logout.ts` | +311 | -50 | +261 | 46 文件 / 7,626 行 | 46 文件 / 7,887 行 |
| 测试 | `tests/antigravity-native.test.cjs`、`tests/client-logout.test.cjs` | +295 | -3 | +292 | 44 文件 / 6,176 行 | 44 文件 / 6,468 行 |
| 开发脚本 | 无 | +0 | -0 | 0 | 3 文件 / 295 行 | 3 文件 / 295 行 |
| 文档 | `docs/account-management.md`、`issues/AGS-0001-antigravity-file-auth.md`、`issues/README.md` | +54 | -9 | +45 | 14 文件 / 908 行 | 14 文件 / 953 行 |

### 文档同步

- 已同步更新 [docs/account-management.md](../docs/account-management.md) 中 Antigravity 的退出能力边界、回退文件与 1 小时超时标记优先级、切换收敛与回滚策略及后台续期清理范围。
- 已将本单顶部状态及 [issues/README.md](README.md) 更新为 `待验收`。

### 自测命令与结果

- `npm run lint`：通过（`tsc --noEmit` 与全部 `renderer/*.js`、`scripts/*.cjs` 语法检查无报错）。
- `npm test`：通过（`270 passed, 0 failed`，含新增的 `tests/antigravity-native.test.cjs` 4 组与 `tests/client-logout.test.cjs` 1 组回退认证与退出测试）。
- 说明：第 2 节末项「真机端到端验收」留待独立验收阶段在真实 macOS 客户端与 `agy` CLI 环境中核验。

### 二次修复补充（针对第 4 节退回问题）

1. **被桌面标记遮蔽的钥匙串身份保护与定向续期写回**：`readAuxiliaryNativeTokens()` 补充纳入与当前主身份不同的 `consumer` 钥匙串条目，切换前统一保护；`writeNativeToken` 在 `clearFallbacks: 'same'` 后台续期桌面回退身份时，仅原子更新桌面回退文件（及同身份/空壳 CLI 文件），不再覆盖异号钥匙串。
2. **全来源切换确认版本绑定与同身份歧义拦截**：新增 `clientSwitchRevision()` / `nativeSwitchFingerprint()` 绑定钥匙串、两处回退文件与两处标记状态，确认期间任一来源变化即中止切换；`syncCurrent()` 对附属凭据补充 `credentialOrder === 'unknown'` 拦截；`useAccount()` 在 `alreadySelected` 且 `hasPendingSwitchCleanup()` 为真时继续执行收敛清理，不再提前跳过异号回退清理。
3. **多存储快照精确回滚、目录符号链接防护与无 `argv` 钥匙串更新**：对 `~/.gemini` 下所有祖先目录校验非符号链接；`captureNativeLiveSnapshot()` 跨整段 `useAccount`（含 `meta.json` 落盘）恢复钥匙串、回退文件与标记原状（保留并发外部新登录，回滚自身失败时显式拼入错误消息告知用户）；`>= 4000` 字节分支改经标准输入与原生 `Security.framework` `SecItemUpdate` 更新，彻底消除命令参数传递凭据。
4. **二次修复自测结果**：`npm run lint`、`npm test`（`280 passed, 0 failed`，含第 4 节全部 6 项边界及大凭据无 `argv` 验收测试）与 `npm run test:ui`（全部 13 套 Electron UI 用例）均通过。

### 三次修复补充（针对第二次独立验收与联合清单 A1–A4）

1. **A1 · 隔离钥匙串大凭据连续更新与严格分区路由（[src/antigravity-native.ts](../src/antigravity-native.ts)）**：
   - 移除大凭据（`>= 4000B`）更新前将原条目置空（`-w ""`）的中间态。无条目与连续大凭据更新均直接经 `osascript` `SecItemUpdate` / `SecItemAdd`（标准输入传参）单步原子更新，中断或拒绝时原字节完整保留；仅当由 `< 4000B`（`apple-tool:`）升级至 `>= 4000B`（`apple:`）或反向降级时按归属分区删除并在后续写入失败且条目为空时恢复原值。
   - 新增 `inspectKeychainOwner()` 通过非解密元数据（`dump-keychain -a`）识别条目存在性与分区归属，`security` 与 `osascript` 严格只读写/删除各自分区条目，消除跨分区触发 macOS `SecurityAgent` 授权弹窗的问题。
2. **A2 · 同邮箱独立凭据防静默合并（[src/antigravity-native.ts](../src/antigravity-native.ts)、[src/accounts.ts](../src/accounts.ts)、[src/client-logout.ts](../src/client-logout.ts)）**：
   - `readAuxiliaryNativeTokens(primaryBytes)` 改为传入主凭据字节并用 `credentialOrder` 逐对比较版本：仅在 `same` / `older` 时去重过滤，`unknown`（同邮箱、同到期时间、不同续期令牌）一律保留并在 `syncCurrent()` 切换前提前阻断报错，绝不删除唯一回退副本；`resolvePrimary()` 与 `fallbackLogoutConflict()` 对同邮箱 `unknown` 顺序同样显式拒绝。
3. **A3 · 切换确认指纹纳入标记生效态并贯穿至最终异步检查后（[src/antigravity-native.ts](../src/antigravity-native.ts)、[src/main.ts](../src/main.ts)、[src/accounts.ts](../src/accounts.ts)、[src/agents/antigravity.ts](../src/agents/antigravity.ts)）**：
   - `nativeSwitchFingerprint()` 改为记录 `marker.exists` 与 `marker.active`（1 小时生效布尔态）而非固定 `mtimeMs`（避免时间自然跨过阈值时指纹不变，也避免正常未过期时的虚假失效）。
   - GUI `use-profile` 无论是否弹窗均记录切换前 `clientSwitchRevision(agent)`，并在 `AntigravityAgent.use()` 完成最终异步 `sharedAntigravitySessions()` 后、实际写入 Keychain 前再次核对 `expectedSwitchFingerprint`。
4. **A4 · 仅撤销 AGS 自身实际写入且未被外部改动的来源（[src/antigravity-native.ts](../src/antigravity-native.ts)、[src/accounts.ts](../src/accounts.ts)）**：
   - 用操作级 `NativeMutationJournal` 替代前置全量盲恢复：前置进程检查失败（`!journal.hasMutations()`）时零写回现场；已发生写入后失败时，仅当某文件或钥匙串当前值仍等于 AGS 本次写入/删除后的目标状态时才恢复原值，外部并发新登录、文件变更或主动退出一律保留。

## 4. 验收记录

**2026-11-19 独立验收未通过，退回修复。** macOS 26.6.2（Apple Silicon）工作区版本，基于 `358eb6d` 及未提交修复。原报错的常规路径已恢复，但补测发现可丢失有效登录。

| 第 2 节验收项 | 实测结果 |
| --- | --- |
| 主复现、仅文件回退 | 通过常规路径。用独立临时 HOME、模拟 Keychain 和测试账号，分别从「Keychain + CLI 文件」和「只有 CLI 文件」保存 A、切到 B、再切回 A。两次均回读到预期目标，CLI 回退文件和标记已清理。 |
| 未入池凭据保护 | 未通过。普通 CLI 回退账号的保存、丢弃测试通过；桌面标记遮住钥匙串中的另一身份、确认期间回退身份变化时仍可能丢失登录。 |
| 后台续期、回滚 | 未通过。常规故障注入通过；背景续期覆盖异号钥匙串、池元数据落盘失败及恢复操作自身失败的结果见下。 |
| 客户端退出 | 既有模拟测试通过，涵盖正常退出及异号/损坏回退拒绝；回退目录为符号链接时的清理边界仍需修复。 |
| 文档同步 | 已同步流程；其中关于保护回退账号与完整回滚的描述尚未在下列情形成立。 |
| 真机端到端 | 未完成。原版 `agy` 1.5.9 在隔离、禁外网环境中可从 CLI 文件分别识别两个合成身份，空目录启动要求登录。此项未验证服务器授权或切换后的钥匙串。桌面 2.33.0 和 CLI 仍需在独立 macOS 用户下用两个可授权账号，从两种初始布局分别完成往返并核对重开后的身份。 |

**已复现的缺陷及复验要求**（A、B、C 均为测试身份）

1. **P1 · 被桌面标记遮住的钥匙串账号丢失。** 钥匙串 A、桌面回退 B、桌面标记有效，两者均未入池。选择「保存后切换」到 C，池内只有 B、C。另测对 B 后台续期，钥匙串 A 也被覆盖。切换前须保护所有将被覆盖的身份，后台续期只更新归属当前身份的存储。见 `src/antigravity-native.ts:165`、`:296`。
2. **P1 · 旧确认会删除新登录。** 钥匙串 A 不变，弹窗期间 CLI 回退从 B 变为 C；按针对 B 的「不保存并切换」继续，C 被删除。确认需绑定所有将被清理的来源及凭据版本；其中之一变化应保留新登录并重新确认。见 `src/main.ts:270`、`src/accounts.ts:253`。
3. **P1 · 同一身份的两份凭据无法判定新旧时，仍静默删除回退副本。** 池内 B 与 CLI 文件 B 的到期时间相同、续期凭据不同。由 A 切 B 返回成功且 CLI 独有副本丢失。应保留或显式解决冲突，再允许清理。见 `src/accounts.ts:136`。
4. **P1 · 切换失败后存储未恢复原状。** 初始仅有 CLI 文件 A 和标记；写入目标后模拟 `meta.json` 落盘失败。操作报错，文件和标记消失，A 被写入原本为空的钥匙串。另测清理失败后恢复钥匙串也失败，仅报告清理错误，钥匙串实际留下目标账号。复验应核对各存储及标记原状，并明确报告恢复未完成。见 `src/accounts.ts:281`、`src/antigravity-native.ts:231`。
5. **P2 · 同身份提前返回。** 当前及目标均为 A，CLI 留有另一账号 B。选择「不保存并切换」后返回成功，却仍保留 B 的文件。仅在所有客户端存储均无需处理时才可跳过切换。见 `src/accounts.ts:268`。
6. **P2 · 回退目录为符号链接时可能清理另一目录。** 隔离试验中，CLI 回退目录链接到第二个测试目录，切换删除了该目录的同名文件。修改前应核对实际目录归属。见 `src/antigravity-native.ts:83`、`:303`。

**验证记录。** `npm run lint`、`npm test`（270 通过，0 失败，0 跳过）及 Electron `tests/ui-providers.cjs` 均通过。上述缺陷来自额外的隔离边界试验。另行核对发现当前工作区的大凭据写入分支会把完整可逆编码的凭据放入系统命令参数，发包前应改用不在进程参数中传递凭据的方式（`src/antigravity-native.ts:212`）。

### 第二次独立验收 · 2026-11-19

**结论：退回待修复。** 本轮对未提交的二次修复实跑 `npm run lint`、`npm test`（280 通过、0 失败、0 跳过）及全部 13 套 Electron UI 测试。补测通过实际切换入口或 GUI IPC，使用隔离 HOME、合成账号和模拟钥匙串复现下列结果。

- 客户常规路径通过：从「只有 CLI 文件」和「Keychain + CLI 文件」两种布局分别保存 A、切 B、切回 A，目标身份与文件清理均符合预期。
- 上轮六个具体场景已通过回归，包括保护被遮住的异号钥匙串与定向续期、弹窗期间换号、备用凭据与池内版本冲突、常规元数据落盘失败与回滚报错、同身份清理，以及拒绝符号链接父目录。大凭据已改走标准输入。

| 仍阻塞发布的场景 | 二次验收实测与复验要求 |
| --- | --- |
| P1 · 同账号独立凭据被合并 | 钥匙串及池内为 A，CLI 为同邮箱、同到期时间、不同续期凭据的 A2。切到 B 成功，A2 文件消失且池内无副本；两处辅助来源为同邮箱时也会合并。应在按邮箱过滤或去重前比较凭据版本，无法判定新旧时保留原件。见 `src/antigravity-native.ts:242`。 |
| P1 · 旧确认在实际写入时仍可生效 | GUI 的指纹能发现弹窗期间 CLI 文件内容变化。但若在随后异步检查共用进程时 CLI 从 B 变为 C，针对 B 的丢弃确认会删除 C。单独刷新桌面标记的修改时间也可改变生效账号而不改变指纹。应将生效标记状态纳入确认，并在实际写入前核对。见 `src/antigravity-native.ts:273`、`src/agents/antigravity.ts:122`。 |
| P1 · 回滚覆盖外部新登录 | CLI 写入新账号 C 后，模拟进程检查拒绝切换（AGS 尚未写凭据），旧快照仍把 C 覆盖。另在写入目标后、元数据落盘失败前重建 CLI 文件 C，回滚同样用旧账号覆盖 C。桌面认证文件也可复现，外部刚退出钥匙串账号时回滚还会恢复旧登录。前置检查失败应保留现场，回滚只应撤销 AGS 自己写入且此后未变的来源。见 `src/accounts.ts:329`、`src/antigravity-native.ts:353`、`:373`。 |
| P1 · 大凭据写入中断后遗留空钥匙串项 | 在 macOS 26.6.2 的隔离测试钥匙串中，首次写入 8,000 字节成功，第二次写同一条目时置空命令在 10 秒后超时，实测原值变为 0 字节。另在完整切换流程模拟第二步系统拒绝更新，回滚也留下空项，下次读取提示「尚未支持此版本的 Antigravity Keychain 格式」。复验需覆盖已有项与无项、连续更新及失败后原值。见 `src/antigravity-native.ts:325`、`src/antigravity-native.ts:355`。 |

真机端到端仍未完成：尚未在独立 macOS 用户下用两个可授权的测试账号，从两种布局分别往返切换，并在每次重开官方桌面与 CLI 后核对身份。本轮未操作真实客户登录。


### 联合验收及接手修复 · 2026-11-19

- 本机运行的是 `/Applications/AgentSwitcher.app` 的旧安装包。检查包内实际读取函数与现场文件类型发现，桌面个人登录回退文件存在，CLI 回退文件不存在。旧读取函数在发现任一文件时立即报错，尚未进入写入。核对仅记录凭据类型与字段是否存在。
- 隔离验收中，另一写入程序更新长 Keychain 条目后能自行回读，但官方端使用的钥匙串读取程序需要重新授权。现实现取消跨权限删除重建并限制写入范围。保留已有条目的原权限和可恢复性仍是长凭据支持的放行条件。
- 模拟测试验证同身份独立凭据冲突、确认后换号、标记翻转、Keychain 写入期间官方端更新文件、失败回滚保留新登录与退出，以及纯文件长凭据的双端落盘。仅通过这些模拟不能确认重开官方客户端后的实际身份。
- 隔离测试条目 `ags-fixture` 曾在当前桌面弹出系统授权请求。本次已停止相关进程。真实钥匙串测试默认跳过，须在专用用户环境中显式启用。真实账号往返本轮未执行。
- 联合清单的逐项结论见[本轮验收结果](../docs/联合返工与验收清单.md#本轮验收结果)。A1 仍有能力限制，本单继续开放。

### A1 长凭据切换补验 · 2026-11-19

长凭据可经确认迁移到桌面与 CLI 的两个官方文件。隔离验收覆盖已有钥匙串、首次文件登录、双端内容及权限、切换中断和外部换号。用户日常会话和系统钥匙串均未参与本次测试。专用用户下的真实客户端往返仍待复验。[联合清单](../docs/联合返工与验收清单.md#a1-长凭据切换复验--2026-11-19)

### 双文件登录补验 · 2026-11-20

桌面与 CLI 文件属于同一身份且共用续期令牌时，保存和切换会保留可用的访问令牌。旧账号池若只存有续期令牌，切出时也能保存这一会话中较完整的凭据。隔离用例已验证切回后仍保有该访问令牌，也覆盖了同邮箱分别登录时保留两份原件，以及其他备用账号独立刷新。真实桌面及 CLI 的双账号往返仍待独立 macOS 用户验收。

1.0.1 发布前查验还发现，同一会话有两份有效访问令牌时，旧排序会忽略写在 JSON 根层的到期时间。现已验证在嵌套字段缺失时使用根级时间、两者并存时优先使用嵌套字段，保存时保留有效期较长的副本。不同会话继续使用原有的身份及续期令牌保护。

本轮 313 项单测通过，1 项真实钥匙串用例按隔离要求跳过，13 套 Electron 界面测试全部通过。CLI 的 4 项使用合成 agy 和临时 HOME，GUI 使用模拟登录；旧空项、已截断的原值以及外部退出并同时清理文件均有回归用例。

后续隔离复核修复了桌面和 CLI 同时使用回退文件时，后台续期导致 CLI 掉线，以及另一 AGS 进程的查询挡住切换的问题。两个客户端的文件、并发变更和跨进程识别已验证。实机双账号往返仍待独立环境验收。[最终隔离复核](../docs/联合返工与验收清单.md#最终隔离复核)

相对本轮开始的工作区，业务源码 9,330 → 9,685 行（+431 / −76），测试 8,305 → 8,678 行（+425 / −52），脚本 295 行（+0 / −0），文档 1,115 → 1,131 行（+22 / −6）。测试超出预估的增量用于覆盖退役前后外部退出和原凭据已经损坏的情况。同期工作区的导航文档变化另计。
