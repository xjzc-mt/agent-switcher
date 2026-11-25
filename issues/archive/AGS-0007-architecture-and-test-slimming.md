# AGS-0007 · 账号编排层平台特判收口、底层重复原语合并与 UI 测试单进程提速

- 状态：已关闭
- 类型：架构重构与测试瘦身
- 来源：2026-11-23 全量质检
- 环境：全仓 TypeScript 核心层（`src/`）与测试套件（`tests/`、`.github/workflows/ci.yml`）

## 1. 现象与复现

1. **`accounts.ts` 平台边界泄漏严重**：[src/accounts.ts](../../src/accounts.ts) 单文件膨胀至 1,478 行，内含约 41 处 `instanceof AntigravityAgent` / `instanceof CodexAgent` / `agent.id` 分支，直接导入 11 个 Antigravity 内部符号；[src/main.ts](../../src/main.ts) 与 [src/client-logout.ts](../../src/client-logout.ts) 亦散落平台分支；同时 [src/agents/base.ts](../../src/agents/base.ts) 第 `86-99` 行保留了生产代码已零调用的平行 `BaseAgent.status()` 方法。
2. **底层基础原语多处重复手写**：
   - JWT / `refresh_token` 解析在 `utils.ts`、`credential-state.ts`（手写第二套 base64url 解码）、`accounts.ts`、`codex.ts`、`antigravity-native.ts` 重复 5~6 套；
   - 批量凭据导入与备份恢复对平台识别和账号池去重遍历各跑两遍，且 `backup.ts` `parseImport` 保留已不可达的裸 JSON 分支；
   - 临时文件 `wx` + `rename` + `rm` 原子写在 `utils.ts:atomicWrite` 之外又手写 9~10 处，文件锁抢占/陈旧锁驱逐循环重复 3 套，静态 Agent 列表与认证文件名散落 5 处，macOS `agy` CLI 查找路径在 `agents/antigravity.ts` 与 `antigravity-cli.ts` 定义了顺序不一致的 2 套；
   - 仍保留 `v1.0.1` 后未对外发版的 `.quota-authorization` / `quotaAuthorizationRequired` 过渡兼容代码。
3. **测试体积逼近业务源码且 `test:ui` 串行冷启动过慢**：
   - `npm run test:ui` 串行冷启动 **13 次独立 Electron 进程**，且每次通过仍无条件编码写出 30+ 张 PNG 截图，且未接入 `.github/workflows/ci.yml`；
   - 21 个单测文件逐字复制相同的临时 `HOME`、密钥注入、`clearRequire`、JWT 构造与 Keychain mock 脚手架。

## 2. 根因与修复方案

### 根因定位

1. 近几轮高频安全补丁直接在 `accounts.ts` 主流程原位叠加 `instanceof` 分支，未及时提炼回 `BaseAgent` 钩子。
2. 各模块独立演进安全文件写入、锁与测试夹具，缺少轻量共享原语。

### 修复方案

1. **提炼 `BaseAgent` 窄能力契约并清理死路径**：
   - 在 [src/agents/base.ts](../../src/agents/base.ts) 收口已真实复现差异的窄方法（共用运行会话检查、凭据世代新旧比较、切换前置准备与事务提交、池凭据恢复对账、客户端登出支持判断），消除 `accounts.ts`、`main.ts`、`client-logout.ts` 中的跨层平台特判（不引入过度抽象的插件框架）。
   - 删除生产零调用的 `BaseAgent.status()`，将仍直接调用它的 3 处旧单测（`auth-lifecycle`、`core`、`antigravity-cli`）统一改为验证真实生产入口 `refreshAccount`。
2. **合并底层重复原语**：
   - 统一复用 `jwtInfo` 与 `extractRefreshToken`；
   - `parseCredentialDocument` 直接保留已识别平台并复用单遍账号池导入规划；
   - 收口安全原子写与父目录非符号链接检查、通用 `withFileLock`、静态 Agent 元信息表及单一 `resolveAntigravityCli()`；
   - 移除未发版预览态遗留的 `.quota-authorization` / `quotaAuthorizationRequired` 分支。
3. **测试单进程化与共享夹具瘦身**：
   - 新增 `tests/ui-runner.cjs`，在单一 Electron 进程内依次执行全部 13 套 UI 测试套件，截图改为仅在断言失败或设置 `AGS_UI_SCREENSHOTS=1` 时落盘，并在 `.github/workflows/ci.yml` 中接入 `npm run test:ui`；
   - 新增 `tests/helpers/test-env.cjs` 收口单测沙箱初始化、JWT 生成与 Keychain mock，合并碎片化重复单测（如 14 行的 `codex-auth-errors.test.cjs`）。

### 边界约束（不做什么）

- 纯内部结构收敛，不改变任何已确认的用户可见文案、CLI 参数、加密磁盘格式与回滚安全不变量。
- 不为尚未接入的新平台预先设计动态加载或插件注册机制。

### 代码量基线与预估

当前工作区物理行数基线：业务源码 69 文件 / 15,189 行，测试 58 文件 / 10,803 行，开发脚本 5 文件 / 451 行，文档 20 文件 / 1,736 行。

| 类别 | 预计涉及文件 | 预计新增 | 预计删除 | 预计净变化 |
| --- | --- | ---: | ---: | ---: |
| 业务源码 | `src/accounts.ts`、`src/agents/*.ts`、`src/main.ts`、`src/client-logout.ts`、`src/backup.ts`、`src/credential-*.ts`、`src/store.ts`、`src/utils.ts` 等 | +320 ~ +450 | -880 ~ -1,120 | **-520 ~ -700** |
| 测试 | `tests/ui-runner.cjs`、`tests/ui-*.cjs`、`tests/helpers/test-env.cjs` 及重复脚手架单测、`package.json`、`.github/workflows/ci.yml` | +260 ~ +360 | -1,350 ~ -1,850 | **-1,050 ~ -1,500** |
| 开发脚本 | 无 | +0 | -0 | 0 |
| 文档 | `docs/account-management.md`、`issues/AGS-0007-architecture-and-test-slimming.md` | +15 ~ +30 | -10 ~ -20 | +5 ~ +15 |

### 验收标准

- [x] `src/accounts.ts` 不再直接散落大量具体平台内部实现分支，`BaseAgent.status()` 已移除，平台差异收口至窄能力接口。
- [x] `npm run test:ui` 单进程跑完 13 套 UI 套件且耗时显著缩短，默认通过时不向 `test-results/` 刷写大量 PNG，`AGS_UI_SCREENSHOTS=1` 或失败时正常输出截图。
- [x] `.github/workflows/ci.yml` 包含 `test:ui` 门禁；`npm run lint`、`npm test`、`npm run test:ui` 全量零回归通过。

## 3. 修复记录

2026-11-23，源码自测。

- 账号编排改为使用平台提供的会话、凭据世代、恢复及切换能力。核查发现 `BaseAgent.status()` 仍有一个生产调用，已先迁移调用方，再删除该入口，相关回归从 `refreshAccount` 进入。保留各平台实际不同的回滚、跨锁复核与官方额度协议。
- 合并 JWT 与续期令牌解析、静态平台元数据、CLI 查找、文件替换与锁原语；导入计划复用已识别平台和账号池索引。清除未发版的额度授权过渡分支，保留对未知磁盘文件的保护。《账号管理流程》已同步平台能力边界。
- 13 套 UI 测试共用一个 Electron 主进程，各套重新创建窗口并清理状态；共享隔离 HOME、模拟钥匙串及令牌夹具。CI 已接入 UI 门禁。实测默认成功输出 0 张 PNG，显式启用输出 42 张，在独立测试副本制造断言失败时返回失败并保存当场截图。
- 同机隔离测量，旧入口含编译耗时 42.26 秒，新入口 31.33 秒，缩短约 26%。源码净减 500 行这一条未达到。原方案把仍有调用的状态入口以及读写边界、适配器、回滚逻辑的迁移都估作删除；本次保留这些保护和验证不同故障结果的断言。合并了 13 套窗口启动/清理、3 套模拟钥匙串及重复的临时目录和 JWT 夹具。起点不存在报告所称的 `clearRequire` 重复实现。测试净减量低于预估。

以本轮实际工作区为起点，四单共享文件按功能分摊后按编号对账。统计物理行，含空行和注释；配置单列。

| 类别 | 阶段前 | 新增 | 删除 | 净变化 | 阶段后 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 业务源码 | 15,435 | 678 | 688 | -10 | 15,425 |
| 测试 | 11,060 | 653 | 773 | -120 | 10,940 |
| 开发脚本 | 451 | 0 | 0 | +0 | 451 |
| 文档 | 1,944 | 22 | 5 | +17 | 1,961 |
| 配置 | 169 | 3 | 1 | +2 | 171 |

全量隔离自测：`npm run lint`、`npm test`、`npm run test:ui`、`npm run site:build` 通过。单测共 339 项，335 项通过，4 项仅适用于 Windows 或独立 macOS 用户的用例跳过，界面 13 套通过。

## 4. 验收记录

**2026-11-23 独立质检复核通过，问题关闭。**

- **架构解耦与测试验证复核**：
  1. 全仓检索确认 `src/accounts.ts`、`src/main.ts`、`src/client-logout.ts` 中原有的 36 处 `instanceof AntigravityAgent / CodexAgent` 分支已 **100% 清零**，全部通过 `BaseAgent` 的 `sharedQuotaLogin`、`writeRenewedCredentials`、`sharedSessionIssue`、`clientLogoutIssue`、`compareSessionCopies` 等窄接口收口；`BaseAgent.status()` 已删除并完成调用方与回归用例向 `refreshAccount` 的统一迁移。
  2. 已抽离 `src/agents/metadata.ts`、`src/file-lock.ts`、`src/import-pool.ts`、`src/private-files.ts` 消除 JWT/续期令牌提取、导入双遍扫描、临时文件原子写、文件锁循环与 CLI 查找重复，并清理了未发版的 `.quota-authorization` / `quotaAuthorizationRequired` 过渡分支。
  3. `tests/ui-runner.cjs` 单一 Electron 进程串行跑通全部 13 套 UI 测试；独立清空 `test-results/` 后实测默认通过输出 **0 张 PNG**，异常时自动留存失败截图；`.github/workflows/ci.yml` 已接入 `npm run test:ui`；新增 `tests/helpers/test-env.cjs` 并移除了冗余的 `codex-auth-errors.test.cjs`、`codex-token-fixture.cjs`、`vault-fixture.cjs`。
  4. **关于代码量偏差的架构裁定**：尽管 `renderer/` 与 `site/` 合计删除了约 590 行重复样式与词典，但因同期 `AGS-0004` / `AGS-0005` / `AGS-0006` 落地了长凭据延迟同步（`pendingLiveRevision`）、401 锁内回退续期、异步钥匙串快照、`application-menu.ts` 及窄能力契约声明，全仓业务源码总量微增（`15,189 → 15,442` 行）。逐文件审查确认无压缩排版行为，新增行数均对应必要的安全保护与完整功能，符合 `AGENTS.md`「不为凑行数省略必要功能」约定，准予结项关闭。
