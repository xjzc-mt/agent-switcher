# AGS 问题与需求总览

`issues/README.md` 是仓库问题单与需求单的**唯一总览路由入口**。
- **LLM / 协作者读取约定**：定位当前待办、缺陷或需求时，**第一步只读本文件**，禁止盲扫 `issues/` 全量文件或 `issues/archive/`；仅根据编号按需读取本次任务对应的 1–2 个活跃单文件。
- **目录热冷分离**：`issues/` 根目录只保留未关闭的活跃单；一旦验收通过变为 `已关闭`，立即移入 `issues/archive/` 并在下方归档索引登记。

## 1. 当前活跃工程单（Active）

| 编号 | 类型 | 状态 | 平台 | 来源 | 模块 | 摘要与当前卡点 |
| --- | --- | --- | --- | --- | --- | --- |
| [AGS-0008](AGS-0008-windows-runtime-and-sandbox.md) | 缺陷/架构 | `待验收` | Windows | local | 沙箱与多平台底座 | Windows 受限令牌沙箱、进程容错与多平台拆文件解耦；CI 标准用户沙箱已过，待 Windows 10/11 真机验收 |
| [AGS-0009](AGS-0009-windows-codex-desktop-support.md) | 缺陷 | `待验收` | Windows | local | Codex 桌面端 | Windows 仅装商店版 Codex 桌面端时的内置 CLI 发现、关窗等待与按原安装重开；待 Windows 真机验收 |
| [AGS-0021](AGS-0021-windows-native-process-and-dpapi-fastpath.md) | 缺陷/性能 | `待验收` | Win / macOS | local | 进程探测与密钥库 | 进程探测与 DPAPI 原生化、只读刷新免写预检及 4 类报错指引已通过源码与自动化复验；待与 0008/0009 一并 Windows 真机终验 |

## 2. 线上 GitHub Issues 分流映射（Online Inbox）

线上 Issues 是面向用户的原始反馈收件箱（可能一帖多事、重复反馈或纯咨询）；维护者核对后按「原子工程闭环」拆入本地 `AGS-xxxx`（1 对多或多对 1），无需改代码的咨询/不采纳项直接在线上回复关闭，不建本地单。

| GitHub Issue | 线上状态 | 反馈摘要 | 关联本地单 / 落地情况 | 线上关单条件 |
| --- | --- | --- | --- | --- |
| [#1 提几个建议](https://github.com/xjzc-mt/agent-switcher/issues/1) | `closed` | ①隐藏未完成入口 ②列表宽度自适应 ③名称列加宽 ④在线更新 ⑤支持代理 ⑥下载链接 | ①~⑥ 均已在 `v0.1.0` 完整上线（含应用内一键更新、双平台本机代理与官网一行命令安装） | 已随 `v0.1.0` 发布汇总回复并关闭 `#1` |
| [#3 正常号和异常号 UI 没对齐 + 定期刷新间隔配置](https://github.com/xjzc-mt/agent-switcher/issues/3) | `closed` | ① 正常双栏卡与单行凭据失效卡底边未对齐<br>② 建议增加可配置的定期刷新间隔 | [AGS-0010](archive/AGS-0010-expired-account-group-and-alignment.md) 与 [AGS-0011](archive/AGS-0011-configurable-quota-refresh-interval.md) 已随 `v0.1.0` 上线 | 已随 `v0.1.0` 发布回复并关闭 `#3` |

## 3. 已关闭归档索引（Archive）

<details>
<summary>已归档 18 项（位于 <code>issues/archive/</code>，点击展开）</summary>

| 编号 | 来源 | 平台 | 关闭日期 / 版本 | 归档记录 |
| --- | --- | --- | --- | --- |
| AGS-0001 | local | macOS | 2026-11-27 (`v0.1.1`) | [Antigravity CLI 无邮箱个人回退认证文件兼容、长凭据双文件迁移与切换收敛保护](archive/AGS-0001-antigravity-file-auth.md) |
| AGS-0002 | local | macOS | 2026-11-20 (`v1.0.1`) | [双屏切换平台时小菜单跳屏](archive/AGS-0002-macos-tray-display.md) |
| AGS-0003 | local | 全平台 | 2026-11-27 (`v0.1.1`) | [Antigravity 免 `agy` 纯桌面原生管理解耦、旧版 CLI 快速阻断与免重启检测](archive/AGS-0003-desktop-only-accounts.md) |
| AGS-0004 | local | macOS | 2026-11-23 (`v0.1.0`) | [Antigravity 额度续期断层、长凭据切换重入与 macOS 钥匙串主线程阻塞](archive/AGS-0004-antigravity-quota-switch-flow.md) |
| AGS-0005 | local | 全平台 | 2026-11-23 (`v0.1.0`) | [账号池跨锁并发竞态、孤儿明文临时目录残留与 Linux 密钥误报](archive/AGS-0005-credential-lock-and-temp-cleanup.md) |
| AGS-0006 | local | 全平台 | 2026-11-23 (`v0.1.0`) | [桌面端样式双源冗余（CSP unsafe-inline）、原生菜单缺失与工程交互细节清理](archive/AGS-0006-desktop-ui-css-and-hygiene.md) |
| AGS-0007 | local | 全平台 | 2026-11-23 (`v0.1.0`) | [账号编排层平台特判收口、底层重复原语合并与 UI 测试单进程提速](archive/AGS-0007-architecture-and-test-slimming.md) |
| AGS-0010 | [GH #3](https://github.com/xjzc-mt/agent-switcher/issues/3) | 全平台 | 2026-11-24 (`v0.1.0`) | [凭据失效账号独立置底分组与备用卡片同行对齐](archive/AGS-0010-expired-account-group-and-alignment.md) |
| AGS-0011 | [GH #3](https://github.com/xjzc-mt/agent-switcher/issues/3) | 全平台 | 2026-11-24 (`v0.1.0`) | [主备独立自动刷新时间间隔、四行紧凑等宽对齐与唤醒调度收敛](archive/AGS-0011-configurable-quota-refresh-interval.md) |
| AGS-0012 | local | macOS / Win | 2026-11-24 (`v0.1.0`) | [应用内更新下载完成后自动安全退出、安装与重启](archive/AGS-0012-seamless-in-app-update-install.md) |
| AGS-0013 | local | 全平台 | 2026-11-24 (`v0.1.0`) | [Codex 有效期内只读优先查额与挂起临时目录自动对账自愈](archive/AGS-0013-codex-quota-pending-recovery.md) |
| AGS-0014 | local | macOS | 2026-11-24 (`v0.1.0`) | [macOS 菜单栏小菜单重设计：常驻展开、额度优先与定宽双列语义胶囊](archive/AGS-0014-macos-tray-redesign.md) |
| AGS-0015 | local | 全平台 | 2026-11-25 (`v0.1.0`) | [Codex 查询失败精确分流自愈与账号详情恢复指引直出](archive/AGS-0015-codex-error-classification-and-detail-guidance.md) |
| AGS-0016 | local | 全平台 | 2026-11-25 (`v0.1.0`) | [版本体系回调至 0.1.0、历史 1.0.x 防回跳与官网跨平台一键安装脚本](archive/AGS-0016-release-0.1.0-and-one-click-install.md) |
| AGS-0017 | local | 全平台 | 2026-11-25 (`v0.1.1`) | [免下载远程元数据离线签名与一键发布脚本](archive/AGS-0017-zero-download-release-signing.md) |
| AGS-0018 | local | Win / macOS | 2026-11-25 (`v0.1.1`) | [Windows PowerShell 5.1 安装脚本 BOM/中文乱码与共享代理 IP 触发 GitHub API 限流修复](archive/AGS-0018-installer-rate-limit-and-ps51-encoding.md) |
| AGS-0019 | local | macOS | 2026-11-26 (`v0.1.1`) | [小菜单跨组件单一数据源、就地切换确认、点击防丢与视口优化](archive/AGS-0019-tray-state-consistency-and-interaction.md) |
| AGS-0020 | local | 全平台 | 2026-11-27 (`v0.1.1`) | [共享号池后台连续智能刷新策略与全端刷新按钮行为统一](archive/AGS-0020-smart-quota-refresh-strategy.md) |

</details>

## 4. 维护规范与生命周期

| 状态 | 目录位置 | 含义 | 下一步动作 |
| --- | --- | --- | --- |
| `待分析` | `issues/` | 已记录现象与环境，尚未敲定方案 | 排查根因，补齐第 2 节并改为 `待修复` |
| `待修复` | `issues/` | 根因、具体方案、代码量预估与验收清单已锁定 | 编码实现、自测、填第 3 节并改为 `待验收` |
| `待验收` | `issues/` | 代码、测试与文档已就位，等待独立复核或真机联验 | 独立审查 diff、跑测试与真机探测，填第 4 节 |
| `已关闭` | `issues/archive/` | 验收通过（未通过则退回 `待修复`） | `git mv` 移入 `issues/archive/`（修正内部 `../` 相对链接为 `../../`），更新本页归档表；发版后同步关闭关联的线上 GitHub Issue |

- **单文件四节固定结构**：头部元信息（状态、日期、平台、来源） + `1. 现象与复现` + `2. 根因与修复方案`（含边界约束、同口径代码量基线与预估、验收清单） + `3. 修复记录` + `4. 验收记录`。
- **职责不重叠**：正式产品行为与架构规则同步沉淀至 `docs/`（如 [账号管理流程](../docs/account-management.md)、[界面设计约定](../docs/ui-design.md)）；具体问题与需求进度唯一以本页为准，不在 `docs/` 重复维护状态流水账。
- **跨会话三原则**：① **追加不篡改**（各阶段只填对应章节，范围显著扩大先对齐再改）；② **同口径对账**（按 [AGENTS.md](../AGENTS.md) 物理行数分业务、测试、脚本、文档对账）；③ **独立验收**（对照第 2 节与真实运行环境独立核验，不单凭第 3 节自述关单）。
