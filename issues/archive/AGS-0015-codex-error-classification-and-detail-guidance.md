# AGS-0015 · Codex 查询失败精确分流自愈与账号详情恢复指引直出

- 状态：已关闭
- 发现日期：2026-11-24
- 平台：全平台（Codex 错误分类 + 桌面端账号详情弹窗）
- 来源：本地真机实测（`2号池-10`、`2号池-2`、`2号池-3`、`2号池-6` 报错「额度查询失败，请稍后重试」，详情弹窗仅显示 `⚠ 查询失败`，操作者无法判断恢复动作）

## 1. 现象与复现

1. 本机部分 Codex 账号（如 `2号池-10`、`2号池-2`、`2号池-3`、`2号池-6`）本地 JWT `access_token` 的 `exp` 虽仍在未来几天，但已被 OpenAI 服务端提前吊销（`/wham/usage` 返回 `401 Unauthorized`，`code: "token_revoked"`，`Encountered invalidated oauth token for user`）。
2. 触发额度刷新并右键打开账号详情弹窗。
3. **实际结果**：
   - 顶部 Toast 仅提示笼统的 `额度查询失败，请稍后重试`，卡片停留在正常 `Plus` 组显示黄色 `⚠`；
   - 账号详情弹窗内仅显示 `⚠ 查询失败   上次额度`（原因文案被藏在 `⚠ 查询失败` 的悬停气泡里，且文案本身也是毫无指导意义的 `额度查询失败，请稍后重试`），也没有快捷「更新凭据」入口，操作者完全不知道该等待网络、检查代理还是重新登录。

## 2. 根因与修复方案

### 根因定位
1. **官方 CLI 鉴权失败文案漏识别（核心根因）**：
   - 真机只读探测确认，当 `access_token` 被服务端吊销（`token_revoked`）时，官方 `codex app-server` 在启动或 `account/read` 时会尝试内部续期并返回 JSON-RPC 错误：
     `Your access token could not be refreshed. Please log out and sign in again.`
     同时 `stderr` 输出：`Failed to refresh token status=401 Unauthorized`（以及 `401 Unauthorized: Encountered invalidated oauth token for user ... "code": "token_revoked"`）。
   - 但 [src/agents/codex.ts](../../src/agents/codex.ts) 第 `32-47` 行 `codexAuthFailure()` 既未匹配 `access token could not be refreshed` / `please log out and sign in again`，也未匹配 `token[_ -]?revoked` / `invalidated oauth token`，直接返回 `undefined`：
     - **在只读探针阶段（`canRotate === false`）**：因 `authFailure === undefined`，未抛出 `QuotaBearerRejected`（第 `445` 行），导致**根本没有尝试用账号池里真实的 `refresh_token` 去换票自愈**；
     - **在真实可续期阶段（`canRotate === true`）**：即便带真实 `refresh_token` 续期仍失败（`stderr` 仅打印 `Failed to refresh token status=401 Unauthorized`，不含 `refresh_token_` 前缀），第 `322` 行 `reason?.startsWith('refresh-')` 也未命中，导致真正连 `refresh_token` 都已失效的账号依然被误判为普通 `state: 'error'`（`额度查询失败，请稍后重试`），无法归入底部 `凭据失效` 组。
2. **非鉴权错误一刀切吞没操作语义**：[src/agents/codex.ts](../../src/agents/codex.ts) 第 `48-52` 行 `queryError()` 将除鉴权外的所有错误统一压成 `'额度查询失败，请稍后重试'`，未区分 `429` 限流、`402/403` 订阅/工作区受限、网络/超时等不同处置方式。
3. **详情弹窗隐藏失败原因且缺少恢复入口**：[renderer/app.js](../../renderer/app.js) 第 `752-757` 行 `accountDetailStatus()` 在 `expired || status?.state === 'error'` 时仅把 `status.extra` 放进 `data-tooltip`，未在详情弹窗正文直接展示原因与下一步操作说明；且需更新凭据的账号在详情弹窗内缺少直接触发 `openCredentialUpdate` 的按钮（注意现有测试 [tests/ui-account-errors-import.cjs](../../tests/ui-account-errors-import.cjs) 第 `37` 行曾断言弹窗内无该按钮，需同步更新）。

### 修复方案

1. **精准区分「只读探针访问令牌失效」与「真实续期令牌失效」（[src/agents/codex.ts](../../src/agents/codex.ts)）**：
   - **扩充 `codexAuthFailure()` 识别范围**：将 `access token could not be refreshed`、`please log out and sign in again`、`token[_ -]?revoked`、`invalidated oauth token` 纳入鉴权拒绝识别（默认归为 `'authentication-rejected'`，注意：**绝不能在 `allowRefresh === false` 只读探针阶段直接标为 `refresh-*`**，因为只读探针传入的是占位符 `ags-refresh-disabled`，若客户端正在运行无法升级续期，不能把正常账号误判为 `expired`！）。
   - **只读探针自动升级自愈**：只读探针（`!canRotate`）命中上述 `'authentication-rejected'` 时，若允许续期则正常抛出 `QuotaBearerRejected`，由 [src/accounts.ts](../../src/accounts.ts) 在复核客户端未占用后自动使用真实 `refresh_token` 执行一次换票查询——若真实 `refresh_token` 仍有效，账号将直接无感恢复正常额度。
   - **真实续期失败明确落入 `凭据失效`**：在 `queryLiveRpc` 允许续期（`allowRefresh === true`）且**确实已向子进程提供真实 `refresh_token` 并触发过续期**（包括 `refreshAttempted === true`，或子进程对真实 `refresh_token` 输出了 `Failed to refresh token` 伴随 `401 / unauthorized / invalid / revoked / expired / reused` 或返回 `access token could not be refreshed. Please log out and sign in again.`）仍失败时，将其提升判定为 `refresh-revoked` / `refresh-invalid`（`state: 'expired', authExpired: true`），给出清晰指引文案：`登录凭据已失效，请点击「更新凭据」重新登录`，使其自动归入底部 **「凭据失效」** 组并将卡片按钮切换为 **「更新」**。

2. **白名单脱敏细分常见非鉴权错误，给出明确操作者指引（[src/agents/codex.ts](../../src/agents/codex.ts)）**：
   - 继续严守不持久化和不回显原始 RPC 敏感文本/Token/邮箱的原则，仅按安全正则映射为可操作提示：
     - **请求限流（`429` / `too many requests` / `rate limit exceeded`）**：`官方接口请求过于频繁（429），无需重新登录，稍后将自动重试`
     - **订阅或工作区受限（`402` / `403` / `forbidden` / `deactivated` / `subscription`）**：`账号暂无可用订阅或工作区受限，请在网页端确认订阅状态或重新登录`
     - **网络/代理/连接与服务异常（超时、`502/503/504`、`ECONN`、`ENOTFOUND`、`TLS/SSL`、`dns`、`proxy`、`network`、`fetch failed`、`connection`）**：`网络连接或官方服务响应异常，无需重新登录，请检查网络或代理后点击刷新重试`
     - **其余未知错误兜底**：`暂时无法读取额度，可点击刷新重试；若多次失败请切换验证或更新凭据`

3. **账号详情弹窗明文直出原因说明与「更新凭据」操作入口（[renderer/app.js](../../renderer/app.js)、[renderer/accounts.css](../../renderer/accounts.css)）**：
   - 在 `accountDetailStatus(status)` 中：当存在 `status?.extra` 时，不再仅藏于 `data-tooltip`，而是在 `detail-status-row` 下方直接渲染 `<p class="detail-note detail-status-note">...</p>` 明文展示原因与恢复建议（避免与标题本身完全同文时重复渲染；移除原状态文字上多余的重复气泡）。
   - 在 `accountDetailActions(id, name, p, dialog)` 中：当该账号满足需更新凭据条件（`canUpdateCredentials(p, status)`，且非 `unsaved`）时，在详情底部操作栏提供醒目的 **「更新凭据」** 按钮（点击后先关闭当前详情弹窗再打开对应账号的 `openCredentialUpdate(id, name)` 更新弹窗），让操作者在详情页看完原因即可一键修复。

### 边界约束（不做什么）
- **严禁误伤客户端运行时的只读保护**：当客户端正在运行导致 `allowRefresh === false` 时，即使 `access_token` 被拒且 `ags-refresh-disabled` 无法续期，也只能提示等待客户端续期或关闭客户端后刷新，绝不能标为 `authExpired: true`。
- **严禁泄露原始报文**：所有错误提示均通过固定中文白名单模板生成，不拼接原始 URL、响应体或 Token 片段。
- 不改变正常卡片与单行列表表面的紧凑结构（表面仍只显示状态简标，详细原因与恢复建议承载在详情弹窗中）。

### 代码量基线与预估（物理行数）

| 类别 | 相关文件基线 | 预计新增 | 预计删除 | 预计净变化 |
| --- | --- | --- | --- | --- |
| 业务源码 | `src/agents/codex.ts` (607)、`renderer/app.js` (1,781)、`renderer/accounts.css` (947) | +35 ~ +60 | -10 ~ -20 | +25 ~ +45 |
| 测试 | `tests/codex-query-identity.test.cjs` (286)、`tests/ui-account-errors-import.cjs` (120) | +35 ~ +60 | -5 ~ -15 | +30 ~ +50 |
| 文档 | `docs/ui-design.md` (140)、`docs/refresh-behavior.md` (86)、本问题单、`issues/README.md` | +15 ~ +25 | -5 ~ -10 | +10 ~ +20 |

### 验收清单
- [x] 只读探针收到官方 CLI `Your access token could not be refreshed. Please log out and sign in again.` 或 `token_revoked` / `invalidated oauth token` 时：① 若允许续期，能自动触发单次真实 `refresh_token` 换票自愈；② 若客户端正在运行（`allowRefresh === false`），保持只读等待提示，绝不误标 `凭据失效`。
- [x] 携带真实 `refresh_token` 续期仍收到上述拒绝或 `stderr` 报 `Failed to refresh token status=401` 时，账号明确转为 `state: 'expired', authExpired: true`（归入底部 `凭据失效` 组，卡片按钮变为 `更新`）。
- [x] `429`、`402/403`、网络/超时等非鉴权错误能映射为包含明确恢复建议的白名单中文说明，不再笼统只报 `额度查询失败，请稍后重试`。
- [x] 打开异常账号的「账号详情」弹窗时，无需悬停即可直接看到清晰的原因说明与下一步操作建议；需更新凭据的账号在详情弹窗内可直接点击「更新凭据」进入对应账号重登/更新流程（同步更新 `tests/ui-account-errors-import.cjs` 对应断言）。
- [x] 检查无冗余死代码残留，`npm run lint`、`npm test`、`npm run test:ui`、`npm run site:build` 全部通过，同步更新相关文档说明。

## 3. 修复记录

2026-11-25 完成源码修复与隔离自测。

- Codex 按实际使用的凭据和失败步骤判定结果。只读副本受到鉴权拒绝时，复用现有版本、身份和客户端占用核对，独立登录最多续期一次，共用登录等待官方客户端。真实续期遭拒时标记凭据失效。额度接口在换票成功后单独返回 401 时保留新凭据，账号仍可重试。
- RPC 回复与标准错误的到达顺序、分块和末行无换行均纳入处理。详情用固定文案区分限流、订阅或工作区受限、网络或代理故障以及未知错误。429 指引兼容手动和定时刷新两种设置。
- 详情在状态下方直接说明原因，移除了重复的悬停气泡和无调用的提示分支。已保存且需更新的账号可从底部进入原有「更新凭据」流程。未保存的账号沿用保存入口。已同步账号管理、额度刷新和界面设计文档。

**自测**　隔离环境执行 `npm run lint` 通过；`npm test` 共 354 项，349 通过，5 项按条件跳过（4 项 Windows、1 项需要独立 macOS 钥匙串用户）。`npm run test:ui` 13 组通过，覆盖可见说明和详情更新目标。另核对 636px 窗口的按钮和长说明。首次站点构建发现输出目录内有 Finder 元数据，移出保留后 `npm run site:build` 通过。源码预览已重新启动，本轮未对真实账号发起查额或续期。

**物理行数对账**　以本轮开始时工作区为基线，含空行和注释。排除依赖、生成物、锁文件与既有变更。

| 类别 | 修改前 | 新增 | 删除 | 净变化 | 修改后 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 业务源码 | 16,771 | 93 | 61 | +32 | 16,803 |
| 测试 | 11,841 | 74 | 14 | +60 | 11,901 |
| 开发脚本 | 565 | 0 | 0 | 0 | 565 |
| 文档（含本单及总览） | 2,721 | 28 | 5 | +23 | 2,744 |

业务增删高于立单预估，涉及替换旧分类、合并详情提示和处理两个输出流的先后顺序。测试净增主要用于区分只读占位令牌、真实续期与续期成功后的额度拒绝，并核对最终分组。

## 4. 验收记录

- **验收日期与结论**：2026-11-25，**全部鉴权分流边界、非鉴权恢复指引、详情弹窗交互与死代码清理核验通过，准予关闭归档**。
- **独立复核要点**：
  1. **只读探针与真实续期严格隔离**：[src/agents/codex.ts](../../src/agents/codex.ts) `queryError()` 对 `!allowRefresh`（只读占位令牌）仅标记 `'authentication-rejected'`，允许续期时触发单次真实 `refresh_token` 换票自愈，客户端占用时保持等待提示不误标失效；真实续期遭拒（含 `id === 3`、`token-refresh-failed` 及 `stderr` `Failed to refresh token` 的 `401` 与验收补齐的 OAuth `400` 响应）明确转入 `refresh-invalid`（`state: 'expired', authExpired: true`），自动归入底部 `凭据失效` 组；换票成功后仅额度接口单独 `401` 时保留新凭据不误废除。
  2. **白名单错误指引与详情直出**：`429`、`402/403`、网络/代理/超时与未知错误均通过 `errorHeader` 剥离 URL 与响应体后映射为固定可操作中文指引；[renderer/app.js](../../renderer/app.js) 移除了重复的状态悬停气泡与废弃的 `accountStatusNote()` 辅助函数（`app.js` 净减 `2` 行），在详情弹窗状态行下方直出原因并在需重登时提供底部「更新凭据」按钮（点击自动关闭详情并进入目标账号更新弹窗）。
  3. **自动化回归**：`npm run lint`、`npm test`（349 通过 / 0 失败 / 5 跳过）、`npm run test:ui`（13 组全绿）、`npm run site:build` 全部通过。
