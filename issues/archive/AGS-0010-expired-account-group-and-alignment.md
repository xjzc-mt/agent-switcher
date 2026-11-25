# AGS-0010 · 凭据失效账号独立置底分组与备用卡片同行对齐

- 状态：已关闭
- 发现日期：2026-11-24
- 平台：全平台（Codex / Antigravity）
- 来源：[GitHub Issue #3](https://github.com/xjzc-mt/agent-switcher/issues/3)（用户截图反馈正常号与异常号卡片底边未对齐）

## 1. 现象与复现

1. 在同一订阅套餐组（如 `Plus` 或 `Pro`）中同时存在正常双栏额度账号与 `⚠ 凭据失效` 账号，切换到「紧凑卡片」多列视图。
2. **实际结果**：正常卡片额度区为双行结构（百分比 + 重置时间，高约 `103px`），`凭据失效` 卡片仅单行状态（高约 `84px`）；由于 [renderer/accounts.css](../../renderer/accounts.css) 中 `.accounts-grid` 设置了 `align-items: start`，正常组末尾与异常卡片处在同一行时出现约 `19px` 的锯齿底边断差。此外，多套餐场景下失效账号散落在各套餐组尾部，单行列表视图下还白白占用整排额度列宽，不利于集中重登或批量清理。
3. **预期结果**：明确不可直接切换、需人工更新凭据的异常账号统一归入最底部的独立分组 **`凭据失效`**（附带原套餐轻量标签、支持折叠与批量管理）；瞬时网络报错或刚导入待首查账号留在原套餐组内不乱跳，且同组同行卡片底边自然对齐。

## 2. 根因与修复方案

### 根因定位
1. **分组维度单一**：[renderer/app.js](../../renderer/app.js) 的 `sortedProfiles` 与 `renderCards`（第 `305-316`、`511-548` 行）仅按 `AccountPolicy.planInfo` 套餐分组，将不可切换的失效账号留在各套餐组内混排。
2. **健康度分桶与更新判定不一致**：[renderer/app.js](../../renderer/app.js) 第 `93-95` 行 `canUpdateCredentials` 已将 `authFailure`（`authentication-rejected` / `account-unavailable` / `quota-recovery-required`）与 `stagedReplacement` 视为需更新凭据，但 [renderer/account-policy.js](../../renderer/account-policy.js) 第 `66-80` 行 `health()` 仅将 `authExpired / expired / signed-out` 判为 `rank = 4`，其余鉴权拒绝落入 `rank = 3`，导致「更新」按钮卡片与带缓存额度的普通查询失败卡片混排。
3. **网格同行顶对齐**：`.accounts-grid` 使用 `align-items: start`，当同组内偶发出现单行无历史额度卡片（如 `unverified` 或首次查询即网络超时）与双行额度卡片同行时，底边高度参差。

### 修复方案
1. **定义统一的「需处理凭据」置底分组判定**：
   - 满足 `canUpdateCredentials(profile, status) || status?.available === false` 的备用账号（即：`credentialsExpired(status)`、明确鉴权拒绝的 `authFailure`、`stagedReplacement` 待替换凭据、本地池凭据损坏不可读），从原套餐组抽离，统一归入最底部的独立分组 **`凭据失效`**（内部保留分组 key 使用 `__invalid__`，避免与真实套餐 key 冲突）；同步修正 `AccountPolicy.health` 使上述鉴权拒绝状态一致归入 `rank = 4`。
   - **不移入底部组的状态（防跳变）**：① 有历史额度的瞬时查询失败（`state === 'error'` 但非鉴权失效）留在原套餐组，保持双栏历史额度与黄色告警图标；② 刚导入尚未首查（`state === 'unverified'`）或首次无历史额度的瞬时网络错误留在原套餐组尾部（未知套餐归入默认未知套餐组）。
2. **底部「凭据失效」分组交互与展示**：
   - **位置与调序**：固定排在所有正常套餐组最下方；「管理」模式下隐藏该组的上下移动按钮（且其他套餐组下移边界不包含该组），但保留组内账号勾选、批量删除与加密导出能力。
   - **保留原套餐标签**：由于脱离了原套餐组标题，该组内卡片在紧凑卡片与单行列表两种视图下均显示轻量原套餐标识（如 `Plus`、`Pro·200`；未知套餐不额外渲染冗余标签），方便用户判断重登或清理价值。
   - **折叠记忆**：复用 `accountGroups.<agent>.collapsed` 持久化 `__invalid__` 折叠状态；折叠时组头显示失效账号数量提示。右上角小菜单（Tray）无需改动（现有第 `358` 行已排除不可切换账号）。
3. **同组同行卡片底边对齐**：
   - 在紧凑卡片视图下，调整 `.accounts-grid` 与 `.account-card` 布局使同一网格行内的卡片外框等高（如默认 `stretch` 并让单行 `.card-resources` 保持自然紧凑居中），确保正常组末尾即使偶发出现刚导入未首查的单行卡片，同行底边也严丝合缝。

### 边界约束（不做什么）
- 不把瞬时网络超时（如 `429` 或断网）踢入底部 `凭据失效` 组，防止后台刷新时卡片跨组跳动。
- 不改变「当前使用」卡片区域的布局与交互。

### 代码量基线与预估（物理行数）

| 类别 | 相关文件基线 | 预计新增 | 预计删除 | 预计净变化 |
| --- | --- | --- | --- | --- |
| 业务源码 | `renderer/account-policy.js` (122)、`renderer/app.js` (1,742)、`renderer/accounts.css` (943) | +45 ~ +75 | -15 ~ -30 | +25 ~ +50 |
| 测试 | `tests/ui-account-groups.cjs` (103)、`tests/core.test.cjs` | +45 ~ +75 | -5 ~ -15 | +35 ~ +65 |
| 文档 | `docs/ui-design.md` (140)、本问题单、`issues/README.md` | +20 ~ +35 | -5 ~ -15 | +15 ~ +25 |

### 验收清单
- [x] `expired`、`authExpired`、鉴权拒绝 `authFailure`、`stagedReplacement` 及 `available === false` 的备用账号统一收拢在最底部 `凭据失效` 组，原套餐组内不再混杂「更新」按钮单行卡。
- [x] `凭据失效` 组在卡片视图和单行视图下均能看清各账号的原套餐标识（已知套餐时），支持独立折叠/展开、搜索过滤及「管理」模式下的勾选删除/导出，且不参与套餐组上下调序。
- [x] 带历史额度的瞬时网络失败（`state === 'error'`）与刚添加的 `unverified` 账号仍留在原套餐组，且同组同行卡片底边平齐无锯齿。
- [x] `npm run lint`、`npm test`、`npm run test:ui` 与 `npm run site:build` 全部通过，同步更新 [docs/ui-design.md](../../docs/ui-design.md)。

## 3. 修复记录

- 2026-11-24。Codex 和 Antigravity 的备用账号按需要处理凭据的条件统一归组。两种视图均显示已知的原套餐。该组固定在底部，可折叠、搜索、勾选、批量导出及删除。短暂网络错误和待首查账号仍在原套餐组，同组同行卡片底边对齐。
- 仅查到过套餐的账号遇到鉴权拒绝或候选凭据验证失败时保留已核对的原套餐，另一工作区不能继承。636px 窗宽下单行失效列表完整显示 Pro·200 和 Enterprise，较长的自定义套餐可悬停查看。已同步《界面设计约定》。
- 隔离验收经过实际额度查询与 dashboard，以及真实 Electron 分组、筛选、折叠和布局测量。全项目 lint、单测（344 通过、5 项依赖专用环境跳过、0 失败）、13 组 UI 与站点构建通过。
- 按本单涉及文件统计物理行（修前／新增／删除／净变化／修后），共享文件只计本单的改动。业务 4,309／81／42／+39／4,348，测试 1,115／79／16／+63／1,178，文档 250／9／6／+3／253。脚本及配置均无变更。

### 2026-11-24 返修

- 移除 `health()` 的等级与文案。组内排序和折叠提示共用 `quotaConfirmed()`，已确认的 0% 额度照常参与排序。移除信用余额角标和查询告警中不可达的凭据过期分支。
- 搜索「凭据失效」能展开整组，「待验证凭据」「凭据不可用」可按卡片实际状态过滤。Electron 用例核对了命中账号，并验证清空搜索后恢复原折叠状态。
- 隔离自测通过 lint、单测（342 通过，5 项因环境跳过）、13 组 Electron UI 与站点构建。已删除只断言旧等级和文案的测试。
- 本单涉及文件物理行数（修前／新增／删除／净变化／修后），共享总览仅计本单修改。业务 1,901／35／57／-22／1,879，测试 267／23／34／-11／256，文档 259／11／4／+7／266。脚本和配置增删均为 0。

## 4. 验收记录

- **验收日期与结论**：2026-11-24，**功能与视觉对齐已通过 Electron 实测，但存在旧排序死代码残留与搜索过滤遗漏，退回 `待修复` 做精简收口**。
- **已验证通过项**：
  - 底部独立 `凭据失效`（`__invalid__`）分组归集、卡片与单行双视图的原套餐标签展示（含防跨工作区继承）、固定置底禁调序、支持折叠/勾选/删除/导出，以及正常组同行混合卡片底边等高对齐均通过 `npm run test:ui`（13 组全绿）验证。
- **退回修改项（须在关闭前完成）**：
  1. **【清理失效沉底旧排序死代码 · [renderer/account-policy.js](../../renderer/account-policy.js)】**：失效/不可用账号已抽离至独立 `invalidGroup`，正常套餐组不再含失效号，`invalidGroup` 内也全是失效号；但 `AccountPolicy.health()`（第 `73-87` 行）与 `compare()`（第 `95-100` 行）仍保留 `rank = 4` 分桶，以及**全仓生产代码 0 调用**的 `.label`（`'需要登录'` / `'上次查询：...'` 等）、`.kind`（`'error'` / `'blocked'` / `'low'` / `'ready'`）和下一行即被 `rank < 3 ? 0 : rank` 丢弃的 `rank = 0/1/2` 分级。请删除冗余的 `health()` 多级对象构造，收敛为单一布尔判定（仅区分「额度已确认可参与数值排序」与「额度待确认排在组尾并计入折叠提示」），并同步精简 [tests/account-policy.test.cjs](../../tests/account-policy.test.cjs) 中仅断言已废弃内部字段（`label` / `kind` / `rank=4` 套餐内沉底）的用例。
  2. **【清理恒假分支 · [renderer/app.js](../../renderer/app.js)】**：`creditCorner(status)`（第 `75` 行）与 `queryWarning(status)`（第 `99` 行）现仅对非 `invalidGroup` 备用卡调用（第 `457`、`460`、`507`、`524` 行），内部 `credentialsExpired(status)` 恒为 `false`，请一并移除。
  3. **【补齐底部组搜索词 · [renderer/app.js](../../renderer/app.js)】**：第 `515` 行 `#accountSearch` 过滤文本纳入了正常套餐组名（`Pro`、`Plus`），但未纳入异常组的组名/状态词（如 `凭据失效`、`待验证凭据`、`凭据不可用`），导致用户输入组名「凭据失效」无法筛出该组账号，请补齐。

### 2026-11-24 返修独立复验
- **复验结论**：**全部返修项核验通过，准予关闭归档**。
- **逐项核对**：
  1. [renderer/account-policy.js](../../renderer/account-policy.js) 已删除无生产调用方的 `health()` 等级/文案构造及 `comparisonStatus` 重复包装（文件由 `129` 行精简至 `101` 行），组内排序与折叠计数统一复用布尔判定 `quotaConfirmed()`，[tests/account-policy.test.cjs](../../tests/account-policy.test.cjs) 同步删去旧内部字段断言；
  2. [renderer/app.js](../../renderer/app.js) 中 `creditCorner` 与 `queryWarning` 内不可达的 `credentialsExpired` 分支已移除；
  3. `#accountSearch` 已支持搜索 `凭据失效`、`待验证凭据`、`凭据不可用` 并在清空后恢复折叠状态（已在 Electron `account-groups` 用例实测通过）。
- **自动化验证**：`npm run lint`、`npm test`（342 通过 / 0 失败 / 5 跳过）、`npm run test:ui`（13 组全绿）、`npm run site:build` 全部通过。
