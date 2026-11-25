# AGS-0003 · 只装官方桌面版时的跨设备账号管理

- 状态为「待分析」。记录日期为 2026-11-23，依据为当前工作区源码、Windows 测试版的用户反馈和下列官方文档。
- 目标设备覆盖现有安装包面向的 macOS Apple Silicon、macOS Intel 和 Windows x64。Agent 范围为 Codex 和 Antigravity。[项目支持范围](../README.md)

## 1. 现象与复现

在只安装 AGS 和 Antigravity 桌面版的 Windows 上，导入 Mac 导出的备份。两个 Antigravity 账号已出现在列表中，但没有切换入口和额度。用户确认 AGS 检查的两个目录均没有 `agy.exe`。同机反馈 Codex 可用，尚无该机跨续期的验收记录。

用户希望导入有效登录后，能在官方桌面切换到指定账号，查询当前和备用账号额度，令牌到期后继续使用。安装组件、找路径和运行终端命令均不应成为用户的日常步骤。

## 2. 根因与修复方案

### Antigravity：先拆开桌面登录识别，再核实在线能力

- **现场原因。** Windows 适配器以找到独立 CLI 作为启用桌面账号管理的条件。切换写入走 Windows 凭据管理器或官方登录文件，读取额度则实际启动 `agy`。账号层还有凭据合并和切换保护依赖 `management().quota`，只放开按钮会漏掉这些保护。[能力判断与切换](../src/agents/antigravity.ts) · [账号保护](../src/accounts.ts) · [额度调用](../src/antigravity-cli.ts)
- **官方支持范围。** Google 说明桌面、CLI 和 IDE 在同机共享登录，并将 `/usage` 列为 CLI 命令。现有证据尚未确认纯桌面安装提供可供 AGS 调用的额度或续期接口。[本机认证](https://antigravity.google/docs/install) · [额度命令](https://antigravity.google/docs/cli/commands/usage/)
- **影响设计的限制。** Google 明确说明消费计划不支持在第三方应用中封装 `agy` 或自动轮换账号，附加条款也限制通过第三方软件访问服务。需复核现有后台查额和续期路径。私有下载或随 AGS 分发 CLI 不能作为已确定方案。用户在官方桌面操作、本地离线备份以及 AGS 主动联网是三种不同动作，应分别核对适用范围。[官方 FAQ](https://antigravity.google/docs/faq/#can-i-use-antigravity-cli-headless-mode-in-third-party-coding-agents-or-automate-account-switching) · [附加条款第 6 条](https://antigravity.google/terms)
- **下一步。** 先以现有纯桌面 Windows 安装核实产品版本、登录存储与官方界面实际使用的身份。分别记录可支持的本地管理和厂商明确支持的联网方式，再定界面开放范围。

### Codex：复用桌面组件，先验收文件登录

- **已有路径。** AGS 可找到 macOS 桌面包内组件和 Windows 桌面版已解出的官方组件。官方 app-server 提供 `account/read` 和 `account/rateLimits/read`，可分别核对身份与查询 ChatGPT 额度。[桌面组件查找](../src/agents/codex.ts) · [Windows 组件发现](../src/codex-process.ts) · [App Server 协议](https://developers.openai.com/codex/app-server/)
- **认证边界。** 文件登录可作为迁机对象。官方还支持系统凭据库和组织强制配置，复制 `auth.json` 未必能改变桌面实际使用的登录。AGS 应保留原配置，在适用的登录模式下核实用户和工作区。[官方认证与登录缓存](https://developers.openai.com/codex/auth/) · [Windows 文件登录判断](../src/codex-file-auth.ts)
- **下一步。** 从纯桌面首次安装开始，记录哪个阶段能找到组件、运行中的桌面如何应用切换、重开后身份与额度是否一致。区分已验证的设备和安装方式，再扩大支持声明。

### 跨设备设计与验收条件

- 迁机交接与多机长期并用分别验收。备份只含导出时的登录版本，源设备仍可能续期。交接要验证目标设备接手，长期并用优先验证厂商支持的每设备独立授权。[现有账号闭环](../docs/account-management.md) · [OpenAI 关于轮换和写回的说明](https://learn.chatgpt.com/docs/auth/ci-cd-auth)
- [ ] 对每个 Agent 分别列出导入、官方桌面激活、当前与备用账号额度、到期续期的证据。遇厂商限制或没有受支持接口的单项，记录原因及用户在官方客户端能完成的操作。
- [ ] 对有支持依据的组合，在无独立 CLI 的干净系统上完成 Mac → Windows 和 Windows → Mac 导入。用两个测试账号往返切换，并在重开后的官方桌面核对实际身份。
- [ ] 对支持查额与续期的组合，保持桌面打开跨一次自然到期，核对当前与备用账号的结果和成功时间。若备用账号续期后写回中断，确认恢复同一账号的新版本，旧版本不会被重复使用。
- [ ] 记录桌面版本、系统架构、登录存储和验证结果。按已覆盖组合更新支持说明；故障与验收材料只保存脱敏结果。

## 3. 修复记录

本次只建档并登记索引。文档预计增加 45–65 行，实际新增 48 行、删除 0 行，合计从 1,711 行增至 1,759 行，其中本地 Issue 从 281 行增至 329 行。业务源码 15,328 行、测试 10,843 行、开发脚本 451 行，本次增删均为 0。实现方案确定后按当时工作区重新估算。

## 4. 验收记录

已核对适配器、账号保护路径和两家官方文档。首个现场证据仅确认 Windows 上的 Antigravity 入口受 CLI 检测阻挡。两个 Agent 的纯桌面跨设备闭环仍按第 2 节逐项验收。
