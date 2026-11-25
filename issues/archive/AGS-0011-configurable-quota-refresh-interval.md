# AGS-0011 · 可配置的定期自动刷新时间间隔与唤醒调度收敛

- 状态：已关闭
- 发现日期：2026-11-24
- 平台：全平台（Codex / Antigravity）
- 来源：[GitHub Issue #3](https://github.com/xjzc-mt/agent-switcher/issues/3)（用户建议增加可配置的定期刷新时间间隔）

## 1. 现象与复现

1. 打开「设置 → 偏好设置」，查看额度刷新相关配置。
2. **实际结果**：[src/quota-refresh.ts](../../src/quota-refresh.ts) 将自动刷新间隔写死为「当前使用 1 分钟、备用账号 5 分钟」，无配置入口；账号较多或使用需串行拉起 `agy` 子进程的 Antigravity 时，后台刷新偏频繁且无法设为仅手动刷新。同时 [renderer/app.js](../../renderer/app.js) 第 `1653-1654` 行在窗口一直可见的情况下每次触发 `window.focus` 也会重复执行 `loadStatus() + refreshAll()`。
3. **预期结果**：在「偏好设置」提供紧凑单行档位选择（`5 分钟 / 15 分钟 / 30 分钟 / 仅手动`），当前号与备用号周期联动生效，缓存陈旧阈值同步适配，且窗口唤醒不做无脑全量强刷。

## 2. 根因与修复方案

### 根因定位
1. **周期常量硬编码**：[src/quota-refresh.ts](../../src/quota-refresh.ts) 第 `9` 行固定 `active ? 60000 : 300000`，[src/settings.ts](../../src/settings.ts) 尚未持久化自动刷新档位。
2. **小菜单缓存陈旧度硬编码 5 分钟**：[renderer/account-policy.js](../../renderer/account-policy.js) 第 `53-55` 行 `stale()` 写死 `> 300000`；若用户调大刷新间隔至 15/30 分钟而不联动该阈值，刷新 5 分钟后小菜单额度即提前变灰标为缓存。
3. **窗口唤醒事件绑定过宽**：[renderer/app.js](../../renderer/app.js) 第 `1649-1654` 行同时监听 `focus` 与 `visibilitychange` 调用 `resumeQuotaRefresh()`，且启动第 `1741` 行固定执行 `refreshAll()`，未区分「仅手动」与定时档位，也造成单纯点击聚焦可见窗口时的冗余调用。

### 修复方案
1. **偏好设置新增 `autoRefreshInterval` 四档单选**：
   - 在 [src/settings.ts](../../src/settings.ts) 增加字段（如 `'5m' | '15m' | '30m' | 'manual'`，默认 `'5m'`，非法值回退 `'5m'`），并在「设置 → 偏好设置」沿用现有单行分段单选样式展示 **`自动刷新间隔`**：`5 分钟` / `15 分钟` / `30 分钟` / `仅手动`。
   - 档位映射规则：
     - `5 分钟`（默认）：当前使用 `1 分钟`，备用账号 `5 分钟`；
     - `15 分钟`：当前使用 `3 分钟`，备用账号 `15 分钟`；
     - `30 分钟`：当前使用 `5 分钟`，备用账号 `30 分钟`；
     - `仅手动`：当前与备用均返回 `Infinity`（不设自动轮询截止时间）。
2. **守住底层防刷保护与退避联动**：
   - 保留 `MIN_REFRESH_INTERVAL_MS = 30000`（30 秒最短保护下限）与 `expired / signed-out / unsupported -> Infinity`（死凭据绝不轮询）。
   - **窗口重置点补查联动**：定时档（`5m / 15m / 30m`）保留 `resetsAt * 1000 + 10000` 到点自动补查；选 **`仅手动`** 时关闭 `resetsAt` 自动触发，仅响应用户主动刷新（右上角「刷新全部」、详情单卡刷新、小菜单刷新）及手动切换账号后的目标号刷新。
   - **失败退避不倒挂**：瞬时 `error` 的自动重试间隔取 `Math.max(backoffMs, configuredIntervalMs)`，避免在 `30 分钟` 档位下因报错反而每 `2 分钟` 轮询（`仅手动` 档报错同样不自动重试）。
3. **唤醒与启动调度收敛（不做唤醒全量强刷）**：
   - 任何档位下窗口唤醒均**不执行** `refreshAll(true)` 全量强刷（全量强刷仅由用户主动点「刷新全部」触发）。
   - 移除 `window.focus` 上无条件串联 `refreshAll()` 的冗余触发（若需同步外部客户端登录变化，仅在切回可见或合理节流下调用本地 `loadStatus()`）。
   - 当窗口从隐藏恢复可见（`visibilitychange` 且 `!document.hidden`）或首次启动完成时：定时档恢复定时器并仅按 `refreshAll(false)` 补刷已逾期的 `deadline <= now` 账号；`仅手动` 档仅执行本地 `loadStatus()`（零自动额度网络请求）。
   - 用户在设置页切换档位保存后，立即刷新本地 `loadStatus()` 重算 `refreshAt` 并重排定时器（从 `仅手动` 切回定时档时按新周期平滑恢复调度），切换设置本身不额外强刷全池网络。
4. **缓存陈旧阈值（`AccountPolicy.stale`）同步适配**：
   - 将 `stale()` 的时间阈值与当前备用刷新档位关联：`max(5 分钟, 备用周期 + 1 分钟宽限)`（即 `5m -> 5m` 或 `6m` 保持兼容、`15m -> 16m`、`30m -> 31m`、`manual -> 30m`），避免低频档位下小菜单过早变灰。

### 边界约束（不做什么）
- 不拆成「当前号输入框 + 备用号输入框」两个自由数字表单，不开放低于 `5 分钟`（备用）/ `1 分钟`（当前）的高频轮询档位。
- 不改动 Antigravity 刷新队列的单路串行（`serialGroup`）保护。

### 代码量基线与预估（物理行数）

| 类别 | 相关文件基线 | 预计新增 | 预计删除 | 预计净变化 |
| --- | --- | --- | --- | --- |
| 业务源码 | `src/settings.ts` (21)、`src/quota-refresh.ts` (22)、`src/accounts.ts` (1,502)、`renderer/account-policy.js` (122)、`renderer/app.js` (1,742)、`renderer/accounts.css` (943) | +65 ~ +100 | -20 ~ -35 | +40 ~ +70 |
| 测试 | `tests/ui-refresh.cjs` (193)、`tests/refresh-coordination.test.cjs`、`tests/core.test.cjs` | +55 ~ +90 | -10 ~ -20 | +45 ~ +75 |
| 文档 | `docs/refresh-behavior.md` (79)、`docs/ui-design.md` (140)、本问题单、`issues/README.md` | +25 ~ +45 | -10 ~ -20 | +15 ~ +30 |

### 验收清单
- [x] 「设置 → 偏好设置」可切换并持久化 `5 分钟 / 15 分钟 / 30 分钟 / 仅手动`，重启后保持生效。
- [x] 各档位下当前账号与备用账号 `refreshAt`、错误退避下限、重置时间点补查及 `AccountPolicy.stale` 阈值均符合上述规则。
- [x] `仅手动` 档位下启动、挂起恢复、窗口切换聚焦及重置时间跨期均不产生后台自动额度请求；手动点击「刷新全部」、单卡刷新、小菜单刷新及切号后刷新正常可用。
- [x] `npm run lint`、`npm test`、`npm run test:ui` 与 `npm run site:build` 全部通过，同步更新 [docs/refresh-behavior.md](../../docs/refresh-behavior.md) 与 [docs/ui-design.md](../../docs/ui-design.md)。

## 3. 修复记录

- 2026-11-24。在偏好设置保存四档刷新间隔，当前及备用账号、重置点补查、失败退避和小菜单缓存共用所选档位。直接查询失败、尚未生成新快照时也按账号周期退避。
- 设置仅手动时，启动、恢复可见、额度重置以及队列中尚未开始的导入附带查询均不会自动查额。主动刷新与切换后的目标查询仍然可用，已经开始的凭据写回可正常完成。定时模式下恢复可见只补到期账号。已同步《额度刷新》与《界面设计约定》。
- 隔离单测和 Electron 实测覆盖四档的持久化、错误退避、缓存期限，切档时的队列接管与 30 分钟档的 IPC 错误。全项目 lint、单测（344 通过、5 项依赖专用环境跳过、0 失败）、13 组 UI 与站点构建通过。
- 按本单涉及文件统计物理行（修前／新增／删除／净变化／修后），共享文件只计本单的改动。业务 5,085／95／45／+50／5,135，测试 1,722／78／16／+62／1,784，文档 338／22／16／+6／344。脚本及配置均无变更。

## 4. 验收记录

- **验收日期与结论**：2026-11-24，**独立验收通过，准予关闭归档**。
- **代码与冗余审查**：
  - [src/settings.ts](../../src/settings.ts) 与 [src/quota-refresh.ts](../../src/quota-refresh.ts) 四档周期映射（`1m/5m`、`3m/15m`、`5m/30m`、`Infinity`）、`30s` 最短冷却、死凭据 `Infinity` 熔断、错误退避 `Math.max(period, backoff)` 不倒挂及 `settings.json` 损坏降级 `'manual'` 均准确精简；
  - [renderer/account-policy.js](../../renderer/account-policy.js) `stale()` 阈值（`5 / 16 / 31 / 30 分钟`）已与刷新档位同步；
  - 旧的 `window.addEventListener('focus', ...)` 重复监听及硬编码 `+60000` IPC 失败重试常量已全部清理无残留；`AccountRefreshQueue` 支持切入 `manual` 时跳过排队中尚未开始的导入/保存附带查额，同时保留手动刷新、切号后目标查额与 `ags status` CLI 可用性。
- **验证执行**：`npm run lint`、`npm test`（344 通过 / 0 失败 / 5 跳过）、`npm run test:ui`（13 组全绿）与 `npm run site:build` 全部通过。

### 2026-11-24 体验优化：主备自动刷新彻底解耦与四行紧凑全等宽对齐
- **调整背景**：用户源码体验后指出，单行 `自动刷新间隔` 隐式绑定主备比例导致界面无法直观看出主账号与备用账号的频率区别，且 4 格分段框与上下 2 格分段框宽度参差。
- **落地方案**：将耦合字段 `autoRefreshInterval` 拆为两个正交设置项 `liveRefreshInterval`（`当前账号自动刷新`：`1 分钟 / 3 分钟 / 5 分钟 / 仅手动`，默认 `1 分钟`）与 `spareRefreshInterval`（`备用账号自动刷新`：`5 分钟 / 15 分钟 / 30 分钟 / 仅手动`，默认 `5 分钟`），兼容旧配置文件平滑迁移；偏好设置四行 `.setting-options` 统一为 `216px` 紧凑全等宽 `1fr` 网格对齐。
