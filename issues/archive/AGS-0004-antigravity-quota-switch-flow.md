# AGS-0004 · Antigravity 额度续期断层、长凭据切换重入与 macOS 钥匙串主线程阻塞

- 状态：已关闭
- 类型：功能缺陷 / 性能与顺畅度优化
- 来源：2026-11-23 全量质检与 Antigravity 全链路审查
- 环境：macOS（已核对本机官方 `Antigravity.app` 2.34.0、`agy` CLI 1.5.14 与当前工作区源码；核心状态机部分同时影响跨平台）

## 1. 现象与复现

1. **备用账号令牌提前失效后刷新卡死**：备用 Antigravity 账号已有 `plan` 且池中 `access_token` 本地 `expiry` 尚未到期时，若服务端提前拒绝该令牌（`401` / `invalid_token`），点击刷新直接报错「Antigravity 未接受本次额度查询的访问令牌」，不会回退用 `refresh_token` 续期，在本地 `expiry` 到期前（最长约 60 分钟）反复刷新均持续失败。
2. **长凭据（`> 4,000B`）更新、续期与共享查额断层**：
   - 当前生效账号原存于 macOS Keychain，点击「更新 → 重新登录」完成浏览器授权后，若新凭据超过 `4,000B`，保存报错且连刚写入账号池的新凭据一并回滚丢弃；同理，客户端未运行时对当前账号做隔离续期若返回 `> 4,000B` 凭据，`writeNativeToken` 直接抛错并在 `$TMPDIR` 遗留未写回临时目录。
   - 当前生效账号处于官方双文件长凭据模式且 `Antigravity.app` 打开时，macOS 下 `readSharedQuotaLogin` 恒返回 `undefined`，1 小时令牌到期后无法触发官方 CLI 共享续期，卡片长期停留在「Antigravity 更新登录状态后，额度会自动刷新。」；此外共享续期在已核实同会话归属时仍丢弃首次 `/usage` 结果并二次拉起 `agy -p /usage`，耗时翻倍且增加触发官方 `429 RESOURCE_EXHAUSTED` 限流概率。
3. **长凭据文件模式重选同账号误触发多余切换，且崩溃残留未在首屏感知**：`hasPendingNativeCleanup()` 将合法双文件主存储误判为残留文件，导致重选当前账号无法走 `alreadySelected` 短路；切换崩溃遗留 `.antigravity-switch.pending` 时，重开 AGS 首屏 `dashboard()` 未感知待恢复状态。
4. **macOS 切号与刷新界面明显顿挫**：每次调用 `readKeychainEntry()` 在主线程同步连开 3~4 个子进程（先 `security` 探测，再跑在常规官方条目上恒以 `77` 失败的 `osascript` JXA，最后 `security -w`），叠加单次切换/刷新在同锁内重复裸读 5~8 轮，累计阻塞 Electron 主线程约 `1.0 ~ 1.8s`。

## 2. 根因与修复方案

### 根因定位

1. **只读快路径缺少令牌被拒回退**：[accounts.ts](../../src/accounts.ts) 第 `1287` 行因 `spareBearer` 存在将备用账号设为 `readOnly = true`（`allowRefresh: false`）；[antigravity.ts](../../src/agents/antigravity.ts) 第 `215-222` 行捕获 `AntigravityAccessRejected` 后因备用账号无 `withSharedRenewal` 直接返回错误，未回退 `queryIsolatedUsage`。
2. **非切换写入未兼容长凭据存储路由，且共享文件观测仅限 `win32`**：
   - [antigravity-native.ts](../../src/antigravity-native.ts) 第 `1029` 行仅在 `clearMode === 'all'` 时走 `switchStorage` 文件迁移；[accounts.ts](../../src/accounts.ts) 第 `818-828` 行与第 `1332` 行调用默认 `clearFallbacks: 'same'`，遇 `< 4,000B` 升至 `>= 4,000B` 即抛错回滚。
   - [antigravity-native.ts](../../src/antigravity-native.ts) 第 `415` 行仅在 `process.platform === 'win32'` 记录文件主存储观测，macOS 文件登录无法进入 `readSharedQuotaLogin`；[antigravity-cli.ts](../../src/antigravity-cli.ts) 第 `250` 行 `querySharedUsage()` 直接丢弃已取得的 `UsageData`。
3. **残留清理判断未排除正式文件主存储**：[antigravity-native.ts](../../src/antigravity-native.ts) 第 `558` 行只要 `desktop` 或 `cli` 非 `absent` 即返回 `true`；`readNativeToken()` 第 `406` 行未检查 `hasPendingAntigravitySwitch()`。
4. **钥匙串读取主次颠倒与重复裸读**：[antigravity-native.ts](../../src/antigravity-native.ts) 第 `377-395` 行把极少数历史 `osascript` 分区兼容探测放在常规 `security` 读取之前，且 `accounts.ts` 同一次锁内操作未复用已读快照。

### 修复方案

1. **备用账号 `401` 自动转续期**：当备用账号仅因 `spareBearer` 进入只读快路径（非 `recoveryReadOnly`、`separateLogin` 或 `liveSession`）且遇 `AntigravityAccessRejected` 时，立即在同一身份锁内回退执行一次 `allowRefresh: true` 的 `queryIsolatedUsage` 续期并写回新令牌。
2. **打通长凭据更新、跨阈值续期与 macOS 共享查额**：
   - 当前生效账号「重新登录更新」或客户端未运行时的隔离续期写回若超出钥匙串上限：无运行客户端时安全迁移至 `0600` 官方双文件并退掉旧钥匙串；若客户端运行中无法即刻切存储，至少保留已写入账号池的新凭据并提示用户切换生效，绝不回滚丢弃已完成的新授权。
   - 在 macOS 无钥匙串且桌面/CLI `0600` 私有文件属于同一会话时，允许纳入 `readSharedQuotaLogin` 归属核验；`querySharedUsage` 返回 `UsageData`，当调用前后确认登录会话（`email` + `refresh_token`）未变且无异号回退介入时直接复用本次额度结果，省去二次 `/usage` 进程启动；后台自动刷新对 Antigravity 采用温和并发（避免突发多路触发 `429`）。
3. **修正文件模式重入判断与中断切换感知**：`hasPendingNativeCleanup()` 在钥匙串为空、无超时标记且桌面与 CLI 文件均为同一目标会话 `0600` 正常文件时返回 `false`；存在 `.antigravity-switch.pending` 时在启动维护或状态读取中明确提示待恢复状态，不静默展示旧钥匙串。
4. **macOS 钥匙串读取提速**：`readKeychainEntry()` 优先走常规 `security` 快速路径，仅在返回分区/权限不可读状态码时才降级尝试 `JXA_KEYCHAIN_READ`；在 `dashboard()` 与单次 `withProfileCredentialLocks` / `useAccount` 周期内复用本机凭据读取结果，将单次操作同步子进程数压降 70% 以上。

### 边界约束（不做什么）

- 严守官方服务条款红线：绝不引入后台自动切号/轮换脚本，不封装模型对话流量，所有查额仅调用官方 `/usage`。
- 不放宽企业账号（`auth_method !== 'consumer'`）、异号回退文件或损坏凭据的安全阻断保护。

### 代码量基线与预估

当前工作区物理行数基线：业务源码 69 文件 / 15,189 行，测试 58 文件 / 10,803 行，开发脚本 5 文件 / 451 行，文档 20 文件 / 1,736 行。

| 类别 | 预计涉及文件 | 预计新增 | 预计删除 | 预计净变化 |
| --- | --- | ---: | ---: | ---: |
| 业务源码 | `src/antigravity-native.ts`、`src/antigravity-cli.ts`、`src/agents/antigravity.ts`、`src/accounts.ts`、`renderer/app.js` | +95 ~ +140 | -65 ~ -95 | +20 ~ +55 |
| 测试 | `tests/antigravity-cli.test.cjs`、`tests/antigravity-native.test.cjs`、`tests/refresh-coordination.test.cjs` | +90 ~ +130 | -15 ~ -30 | +70 ~ +105 |
| 开发脚本 | 无 | +0 | -0 | 0 |
| 文档 | `docs/account-management.md`、`docs/refresh-behavior.md`、`issues/AGS-0004-antigravity-quota-switch-flow.md` | +20 ~ +40 | -15 ~ -25 | +5 ~ +20 |

### 验收标准

- [x] 备用账号池内持有未过本地 `expiry` 但被服务端返回 `401` 拒绝的 `access_token` 时，单次刷新可自动回退 `agy acp` 续期并更新额度与池内令牌。
- [x] 当前生效账号「重新登录更新」或闲置续期产生 `> 4,000B` 凭据时，新凭据安全落盘且不回滚丢失；macOS 长凭据文件模式重选同账号走快速短路，不重复重启客户端。
- [x] macOS 共享续期在同会话核验通过后单次完成查额，不重复拉起第二次 `/usage`；存在 `.antigravity-switch.pending` 时界面明确提示待恢复状态。
- [x] macOS 常规钥匙串读取不再每次先拉起 `osascript` JXA，单次切换与 `dashboard()` 的同步子进程调用次数显著下降，界面无明显卡顿。
- [x] `npm run lint`、`npm test`、`npm run test:ui` 全部通过，并在本机 `Antigravity.app` 2.34.0 + `agy` 1.5.14 源码运行体验顺畅。

## 3. 修复记录

2026-11-23，源码自测。

- 已从生产调用链核实三处故障。备用账号的未过期访问令牌被官方拒绝时，在同一身份锁内仅允许独立且可续期的登录改走一次官方 ACP。官方限流、身份冲突、待恢复写入均不会触发这次换票。界面同时只调度一个 Antigravity 查询，其他平台可以使用空余并发位。
- 当前账号新授权超过钥匙串写入上限时，先提交账号池。客户端空闲时经原切换事务写入两个私有文件，繁忙时保留新授权并提示稍后切换。macOS 双文件属于同一会话时可共享续期，调用前后核对邮箱、续期令牌与来源后直接使用本次官方额度结果。中断切换在首屏可见，重选已生效的正常双文件账号走短路。
- 钥匙串取值使用 `security` 快速路径；首次读取仍先用禁交互的 JXA 检查唯一条目、解锁状态和访问控制。直接先取密码有弹系统授权框的风险。工具权限被拒时，仅对同一条目版本走禁交互后备读取。读快照限于同一同步阶段，越过等待或提交边界会重新核对。
- 隔离自测涵盖提前 401、长凭据、共享登录变更、异常中断及回滚。相同模拟钥匙串下，跨账号切换的同步子进程调用 55 → 15，重选当前账号 48 → 4。桌面状态 IPC 把常规钥匙串读取移到异步路径。真实账号的本次跨期与桌面体验仍待独立验收；2026-11-21 的记录属于先前源码。
- 已同步《账号管理流程》《额度刷新》和《当前待办》。

以本轮实际工作区为起点，四单共享文件按功能分摊后按编号对账。统计物理行，含空行和注释；配置单列。

| 类别 | 阶段前 | 新增 | 删除 | 净变化 | 阶段后 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 业务源码 | 15,182 | 283 | 110 | +173 | 15,355 |
| 测试 | 10,804 | 130 | 22 | +108 | 10,912 |
| 开发脚本 | 451 | 0 | 0 | +0 | 451 |
| 文档 | 2,042 | 36 | 16 | +20 | 2,062 |
| 配置 | 165 | 0 | 0 | +0 | 165 |

全量隔离自测：`npm run lint`、`npm test`、`npm run test:ui`、`npm run site:build` 通过。单测共 339 项，335 项通过，4 项仅适用于 Windows 或独立 macOS 用户的用例跳过，界面 13 套通过。

### 2026-11-23 实机阻断返修

- 本机已解锁的登录钥匙串里只有一个官方条目，允许系统工具读取。旧代码在修复前对该条目的同步读取、异步读取及共享查询判断均失败，重现了官方客户端换号后 AGS 无法识别当前登录的问题。
- 显式声明 Security.framework 的 JXA 输出类型，核对条目及所属钥匙串。同步、异步和共享额度检查统一先走禁交互读取，只有条目已有适用的系统工具授权才启用工具读取。工具读完复核条目版本，避免把换号前的凭据归给另一账号。
- macOS 26.6.2 的真实 `login.keychain-db` 只读自测通过。同步读取非空（258 ms），异步读取非空（252 ms），`canReadNormalQuotaLogin()` 返回 true（120 ms），探针前后条目版本一致。探针仅记录结果和耗时。隔离回归另覆盖旧 osascript 条目、权限拒绝、重复项及读取途中换号。
- 本批完整自测通过 lint、单测（340 项通过，5 项依赖专用环境跳过，0 失败）、UI（13 组）和站点构建。《账号管理流程》已同步。
- 本轮物理行数账目（修前／新增／删除／净变化／修后）：业务 254／89／99／-10／244，测试 1290／46／67／-21／1269，文档 436／12／1／+11／447。含本批共用的《账号管理流程》。脚本与配置无变更。

## 4. 验收记录

**2026-11-23 独立质检复核通过，问题关闭。**

- **代码与安全边界复核**：
  1. 备用账号 `spareBearer` 快路径遇 `QuotaBearerRejected`（`401`）时，先在锁内重检 `sharesClientCredential`、`hasRunningLiveSession` 与原凭据 `revision` 未变，再回退单次 `allowRefresh: true` 隔离续期，限流/网络异常与恢复冲突不误触发二次换票。
  2. 可信重新登录（`replaceAccountCredentialsLocked`）先落盘账号池并记录 `pendingLiveRevision`，`writeRenewedCredentials` 在客户端空闲时原子迁移至 `0600` 官方双文件并退掉旧钥匙串，繁忙时保留池内新授权并引导切换（切换时 `acceptingUpdate` 自动识别待替换旧授权，不误弹未入池保存询问）。
  3. macOS 双 `0600` 私有文件同会话已纳入 `readSharedQuotaLogin`，调用前后核实同会话且无异号回退介入后直接采用 `querySharedUsage` 返回的 `UsageData`，消除二次 `/usage` 重复调用；`AccountRefreshQueue` 对 `agy` 启用 `serialGroup` 单路串行刷新；`hasPendingNativeCleanup` 与 `readUnavailableDesktopQuotaFile` 已分别修复合法双文件重选短路与 `.antigravity-switch.pending` 首屏暴露。
  4. ~~在本机 macOS 26.6.2 实跑 `/usr/bin/osascript -l JavaScript` 核验 `JXA_TOOL_ROUTE` 对二进制 plist `Partitions` 解析正常~~（见下方实机复核订正）；`get-status` IPC 经 `withDashboardNativeSnapshot` 改为异步子进程读取钥匙串，写操作与跨等待边界前强制清空 `readSnapshot`。
- **独立验证结果**：实跑 `npm run lint`、`npm test`（339 项：335 通过 / 0 失败 / 4 跳过）、`npm run test:ui`（13 套全过）全部通过。

### 补充实机复核 · 2026-11-23（退回 `待修复`）

- **用户源码实跑现象**：启动当前工作区源码（`1.0.1+332b1973e7da`）打开 Antigravity 页，首屏顶部立即弹出红框「无法读取 Antigravity 登录钥匙串，请先解锁并在官方客户端确认当前登录，再手动保存或切换」，当前账号显示「登录状态待核对」，并连带导致 `sharesClientCredential` 返回 `'unknown'` 阻塞过期备用账号续期。
- **根因实测定位（代码在 AGS-0008 中已拆至 [src/antigravity-mac.ts](../../src/antigravity-mac.ts)）**：
  1. 本机 `login.keychain-db` 处于已解锁正常状态（`flags = 7`），且 `gemini / antigravity` 为标准官方 `go-keyring` 条目（`partition_id: apple-tool:`，`decrypt` ACL 已显式授权 `/usr/bin/security` 免密读取）。
  2. 但 [src/antigravity-mac.ts](../../src/antigravity-mac.ts) 第 `41-50` 行 `JXA_UNLOCKED_ITEM` + `JXA_DESKTOP_TOOL_ACL` 中，JXA 无类型 `const item = Ref()` 接收 `SecKeychainItemCopyFromPersistentReference` 输出时，`item[0]` 被桥接为 `CFNull`（`CFTypeID = 18`，而非 `SecKeychainItem` 的 `87`；`SecKeychainItemCopyKeychain(NULL, ...)` 仅因传入 `NULL` 回退读取默认钥匙串而侥幸返回 `0`），随后 `$.SecKeychainItemCopyAccess(item[0], access)` 恒返回 **`OSStatus = -25243`（`errSecNoAccessForItem`）** 并 `$.exit(77)`。
  3. `macKeychainRead()`（第 `136-155` 行）在 `JXA_TOOL_ROUTE` 返回 `77` 时 `route.raw` 为 `undefined`，第 `139` 行直接**跳过了 `/usr/bin/security find-generic-password -s gemini -a antigravity -w`**，转而调 `osascript` `JXA_KEYCHAIN_READ`（因条目属 `apple-tool:` 分区而必返 `-25293` / `77`），最终 100% 误报钥匙串无法读取；同文件的 `canReadNormalQuotaLogin()`（第 `195` 行）存在同一问题。
  4. **此前验收漏检原因**：前次验收仅对独立二进制 plist 十六进制解析做了合成输入验证，未对本机真实钥匙串条目实跑完整 `JXA_TOOL_ROUTE` / `readMacKeychain()`。
- **修复要求**：
  - 修复 [src/antigravity-mac.ts](../../src/antigravity-mac.ts) 的 macOS 钥匙串读取与 `canReadNormalQuotaLogin()`：不要依赖 JXA 破损的无类型 `Ref()` -> `SecKeychainItemCopyAccess` 链路阻断 `/usr/bin/security` 读取；在确认条目唯一且所属钥匙串已解锁后，对非 `osascript` 分区的常规条目正常走 `/usr/bin/security` 读取（或用本机实测可工作的无弹窗方式核验），并缓存已确认可读的 `revision` 减少子进程开销。
  - 修复后须在本机真实 `login.keychain-db`（不打印凭据明文，仅核验读取成功与耗时）实测验证 `readMacKeychain()`、`readMacKeychainAsync()` 与 `canReadNormalQuotaLogin()` 均返回预期结果。

### 二次独立实机复验 · 2026-11-24（通过，已关闭）

- **代码复核（[src/antigravity-mac.ts](../../src/antigravity-mac.ts)）**：
  - 已通过 `ObjC.bindFunction` 显式声明 `SecKeychainItemCopyFromPersistentReference`、`SecKeychainItemCopyKeychain`、`SecKeychainItemCopyAccess` 等指针输出签名，并严格断言 `CFGetTypeID`（`SecKeychainItemGetTypeID` / `SecKeychainGetTypeID` / `SecAccessGetTypeID`），彻底修复 `Ref()[0]` 退化为 `CFNull` 导致返回 `-25243` 的桥接缺陷；
  - `JXA_READ_ROUTE` 先对同一持久化引用执行禁交互读取（兼容历史 `osascript` 条目且单进程返回），未获权时核验该解锁条目明确向 `/usr/bin/security` 授予免密 `decrypt` 且包含 `apple-tool:` 分区后再调用 `/usr/bin/security find-generic-password -w`，并在取值后二次复核 `JXA_SHARED_REVISION` 防止并发换号串读；`canReadNormalQuotaLogin()` 复用同一路径（`checkOnly = true`）。
- **本机真实环境无损探针与全量回归（macOS 实测）**：
  - 对本机真实 `login.keychain-db` 执行只读无损探针（不输出任何明文凭据或邮箱）：`readMacKeychain()` 成功（278 ms，882 字符）、`readMacKeychainAsync()` 成功（210 ms）、`canReadNormalQuotaLogin()` 返回 `true`（90 ms）、`sharedMacRevision()` 前后一致（69 ms），`withDashboardNativeSnapshot` 驱动 `dashboard()` 返回 `state: "ok"`、`available: true`、`extra: null`（250 ms，识别当前登录与 2 个备用账号，全程零系统弹窗）；
  - `npm run lint`、`npm test`（340 通过 / 0 失败 / 5 环境跳过）、`npm run test:ui`（13 组一次全过）与 `npm run site:build` 全部通过。
- **验收结论**：**通过，问题关闭**。
