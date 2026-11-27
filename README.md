<div align="center">
  <img src="packaging/app-icon.png" width="128" alt="AgentSwitcher · AGI 之门与五个 Agent 搭档" />
  <h1>AgentSwitcher · AGS</h1>
  <p><strong>中文</strong> · <a href="README.en.md">English</a> · <a href="https://xjzc-mt.github.io/agent-switcher/">产品主页</a></p>
  <p><strong>与 Agent 并肩，与伙伴同行，携手走向 AGI 之门。</strong></p>
  <p>
    不管你手头攒了多个个人号与团队号，还是搭档、朋友临时借你一个 <strong>Codex</strong>、<strong>Antigravity</strong> 账号救急——<br />
    放进同一个桌面窗口：谁还有余量一眼看清，点一下顺手切换，既不打断心流，也不误覆盖原有主号。
  </p>
  <p>
    <a href="docs/release-0.1.1.md"><img src="https://img.shields.io/badge/release-0.1.1-4F46E5?style=flat-square" alt="0.1.1 release" /></a>
    <img src="https://img.shields.io/badge/desktop-macOS_%C2%B7_Windows_x64-172033?style=flat-square" alt="macOS Apple Silicon, macOS Intel, Windows x64" />
    <img src="https://img.shields.io/badge/agents-Codex_%C2%B7_Antigravity-6366F1?style=flat-square" alt="Codex and Antigravity" />
    <img src="https://img.shields.io/badge/privacy-%E9%9B%B6%E8%87%AA%E5%BB%BA%E5%90%8E%E7%AB%AF_%C2%B7_AES--256--GCM-0D9488?style=flat-square" alt="零自建后端 · AES-256-GCM" />
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-64748B?style=flat-square" alt="MIT License" /></a>
  </p>
  <p>
    <a href="https://github.com/xjzc-mt/agent-switcher/releases">查看发布记录</a> ·
    <a href="#界面速览">界面速览</a> ·
    <a href="#安全与支持范围">安全与支持范围</a> ·
    <a href="#快速安装">快速安装</a> ·
    <a href="docs/release-0.1.1.md">0.1.1 版本说明</a> ·
    <a href="#门后的彩蛋">✦ 门后彩蛋</a>
  </p>
</div>

![Codex 账号总览：当前账号、套餐分组和备用额度](docs/images/01-codex-cards.png)

<p align="center"><sub>真实桌面界面演示截图（使用虚构账号与模拟额度，不含真实凭据）</sub></p>

---

## 界面速览

### 1. 看余量，不盲猜

当前账号置顶，备用账号按套餐归组、按可用余量排好序，支持**卡片**与**单行**两种视图。Codex 分列 `5h / 7d` 与 Credits；Antigravity 以 `Gemini` 为主并独立展示 `Claude / GPT` 等模型组，缺失值如实显示 `—`，不混算总比例。

在 macOS 上，点右上角菜单栏的 AGS 图标即可直接查看当前额度与备用账号双列胶囊列表，点击即可切换。切换平台时，菜单留在打开它的那块屏幕上。

| Codex 单行视图 · 密集对齐比对 | Antigravity · 模型组主次分层 |
| --- | --- |
| ![单行视图：按套餐比较多个账号的额度](docs/images/02-codex-rows.png) | ![Antigravity：当前与备用账号的模型组额度](docs/images/03-antigravity.png) |

### 2. 添账号，不掉线

在浏览器中完成官方授权，可连续添加账号，**当前客户端保持登录**。在 Windows 选择无痕登录时，AGS 会复制链接，供你粘贴到无痕窗口。多账号 JSON 可先预览、改名、按身份去重再导入；过期账号可原位更新并保留昵称；从文件导入的替换凭据须先验证归属（详见 [导入格式](docs/session-import.md)）。

| 独立浏览器授权 · 支持无痕与连续添加 | 批量导入预览 · 改名、去重与过期替换 |
| --- | --- |
| ![添加账号：官方浏览器登录与连续添加](docs/images/04-add-account.png) | ![批量导入：选择、命名与身份去重](docs/images/05-import-preview.png) |

### 3. 留备份，不伤现场

勾选账号并设置至少 6 个字符的独立密码，即可导出 `.ags` 加密备份，在另一台电脑上恢复。移除前先摊开确认范围，**默认只删 AGS 内的备份**，完整保留官方客户端登录、聊天历史与项目文件。

| 加密导出 · 独立密码保护 `.ags` 备份 | 移除确认 · 默认保留客户端现场 |
| --- | --- |
| ![加密备份：选择账号并设置独立密码](docs/images/06-encrypted-backup.png) | ![移除确认：展示范围，退出客户端由用户选择](docs/images/07-remove-confirmation.png) |

---

## 安全与支持范围

- **零自建后端，透明可审**：无自建服务器、无统计 SDK 与遥测上报；登录仅放行 OpenAI 与 Google 官方授权域名，也可直接从源码启动。
- **本机强加密**：账号凭据使用 `AES-256-GCM` 加密。macOS 钥匙串或 Windows 当前用户的 DPAPI 保护主密钥，导出的 `.ags` 备份使用独立密码。
- **不丢号、不越界**：未保存的当前登录在切换前会先弹窗提醒保护；只替换登录凭据，不动聊天记录与项目配置，也不会在后台自动切号。
- **边界清楚**：放入他人账号须事先获持有人授权；本版仅限本机使用。详细机制见 [账号管理流程](docs/account-management.md) 与 [额度刷新](docs/refresh-behavior.md)。

| 平台 | 状态 | 支持能力与使用条件 |
| --- | :---: | --- |
| **Codex** (`codex`) | ✅ 已支持 | 独立登录、`auth.json` 切换、`5h / 7d` 额度与 Credits（需桌面端内置或独立安装的 Codex CLI；Keychain-only 未适配，API Key 无订阅额度） |
| **Antigravity** (`agy`) | ✅ 已支持 | 仅装 Antigravity 2.x 桌面即可保存、导入和手动切换个人 Google 账号；查看模型组额度与独立浏览器登录需安装官方 `agy` 1.5.9+ CLI（企业认证暂未验证） |

**0.1.1 跨平台状态**：macOS（Apple Silicon / Intel）与 Windows x64 均已通过安装、启动与自动化回归验证。Windows 支持使用独立安装或 Microsoft Store 版 Codex 内置组件登录与查额度、原生极速检测进程与 DPAPI 密钥，以及仅装 Antigravity 2.x 桌面的个人账号切换；安装官方 `agy` 1.5.9+ 后点击「重新检测」即可启用额度查询。Mac 双真号往返及 Windows 真机全流程终验仍在进行中。

---

## 快速安装

已安装 `0.1.0` 的用户可直接在应用内 **「设置 → 应用与更新 → 立即安装并重启」** 一键升级。首次安装（或从早期 `1.0.x` 测试包无损切换至 `0.1.1`）推荐使用一行命令自动识别架构、核对签名清单并完成安装：

```bash
# macOS（需 macOS 13+，自动识别 Apple Silicon / Intel 并安装至 /Applications）
curl -fsSL https://xjzc-mt.github.io/agent-switcher/install.sh | bash
```

```powershell
# Windows x64（PowerShell）
irm https://xjzc-mt.github.io/agent-switcher/install.ps1 | iex
```

也可直接下载 `0.1.1` 安装包：
[macOS · Apple Silicon（DMG）](https://github.com/xjzc-mt/agent-switcher/releases/download/v0.1.1/AgentSwitcher-0.1.1-arm64.dmg) · [macOS · Intel（DMG）](https://github.com/xjzc-mt/agent-switcher/releases/download/v0.1.1/AgentSwitcher-0.1.1-x64.dmg) · [Windows · x64（EXE）](https://github.com/xjzc-mt/agent-switcher/releases/download/v0.1.1/AgentSwitcher-Setup-0.1.1-x64.exe)

- **macOS** 打开 DMG，将 AGS 拖入「应用程序」。切换前先结束官方客户端中的任务，确认后 AGS 会退出并重开原先运行的桌面客户端。使用 Antigravity 时，请先关闭共用登录的 `agy` 或 IDE 会话。
- **Windows** 运行 EXE 安装。切换前请先结束共用登录的 CLI 或 IDE 会话；若 Codex 桌面正在运行，确认后 AGS 会关闭并在切换完成后按原方式重开。

```bash
shasum -a 256 AgentSwitcher-*.dmg   # macOS。将结果与同版 SHA256SUMS 对照。
# Windows PowerShell: Get-FileHash .\AgentSwitcher-Setup-0.1.1-x64.exe
```

> [!IMPORTANT]
> macOS 安装包采用 **ad-hoc 签名**（尚未接入 Apple 公证）。使用上方 `install.sh` 命令安装会自动核对签名清单；若手动下载拖入 DMG 后首次打开提示无法验证开发者，核对 `SHA256SUMS` 后前往 **「系统设置 → 隐私与安全性」滑至底部点击「仍要打开」** 即可。

遇到问题时，在「设置 → 应用与更新 → 导出故障报告」保存近期操作的脱敏记录，可自行决定是否私下转交维护者。也可查看[已知问题记录](issues/README.md)或到 [GitHub Issues](https://github.com/xjzc-mt/agent-switcher/issues) 反馈。**切勿上传真实凭据 JSON、Token 或备份密码**。

<details>
<summary><strong>偏好设置与应用内更新</strong></summary>

可在设置中切换重置时间格式（倒计时 / 日期时间）、分别设置当前与备用账号自动刷新间隔、调整无痕登录行为或复制 Codex 历史数据排查指令。

macOS 与 Windows x64 版均可在应用内下载匹配架构的新版安装包。AGS 使用内置 Ed25519 公钥验证发布清单并核对 SHA-256，校验通过后点击「立即安装并重启」即可安全退出、替换并重开新版。[应用内下载更新](docs/app-updates.md) · [GitHub Releases](https://github.com/xjzc-mt/agent-switcher/releases)

![设置：紧凑的偏好、清理辅助与应用更新](docs/images/08-settings.png)

</details>

<details>
<summary><strong>源码运行、<code>ags</code> CLI 与开发者文档</strong></summary>

需要 **Node.js 22.12+**、npm 与图形桌面环境（DMG 不自动安装终端命令，需 `ags` 可在构建后执行 `npm link`）：

```bash
git clone https://github.com/xjzc-mt/agent-switcher.git && cd agent-switcher
npm ci && npm run build && npm run gui

# 常用 CLI（切换前请先手动关闭对应桌面客户端；未保存的当前账号需加 --save-current 或 --discard-current）
ags save codex work      # 保存当前登录
ags list                 # 查看已保存账号
ags status               # 查看当前激活状态
ags use codex work       # 切换至指定账号
ags use agy work --allow-file-storage  # 同意将长凭据保存到桌面与 CLI 各自的私有登录文件
ags rm codex work        # 预览移除范围（加 --yes 执行，加 --logout 同步登出）

# 回归使用演示凭据，真实钥匙串集成测试默认跳过
npm run lint && npm test && npm run test:ui
npm run screenshots      # 重新生成演示截图
npm run site:build       # 生成 GitHub Pages 静态站点到 out/site
npm run dist             # 本地构建 DMG
```

文档索引：[账号管理流程](docs/account-management.md) · [额度刷新](docs/refresh-behavior.md) · [Session 导入](docs/session-import.md) · [界面设计约定](docs/ui-design.md) · [应用内更新](docs/app-updates.md) · [构建与发布](docs/releasing.md) · [打包与体积](docs/package-size.md) · [截图说明](docs/images/README.md) · [MIT License](LICENSE)

</details>

---

## 门后的彩蛋

<p>
  <img src="assets/gate-mark.png" width="24" align="absmiddle" alt="AGS 门标" />
  <strong>顶部那扇「AGI 之门」下，人与众 Agent 并肩、人与人彼此托举——AgentSwitcher 只是序章。</strong>
</p>

一款围绕 **私密信任圈 · 额度零浪费 · 彼此互助** 打造的**划时代个人微中转产品**已进入发布倒计时，即将揭晓。

<details>
<summary><strong>🔮 点击推开高门 · 解锁「终局形态」预言</strong></summary>

今天朋友借号还得导凭据，深夜里大量订阅窗口又在倒计时中白白清零。而在终局形态里，**每个人都可以是一座自主受控的「个人小中转」**（并非公共商业号池或账号倒卖，而是熟人与小团队的私密互助工具）：

- **借力免交凭据**：账号空闲时，本机即可化作轻量微中转节点，搭档按需借力，无需交出密码或明文 JSON。
- **信任圈私密默认，开关全权在己**：默认仅对认可的熟人与小团队开放；谁能连、用多少、外部限制开关均由你本机实时掌控、随时撤回。
- **闲置余量零浪费**：队友赶工借你空闲窗口顶上，你冲刺时也有伙伴余量接力，让每一份订阅物尽其用。

> 先点亮右上角 **`Star`** 并在 **`Watch → Custom → Releases`** 订阅通知——当那扇门真正敞开时，第一时间见。

</details>

<sub>注：彩蛋为下一代独立产品预言；AgentSwitcher 仅提供纯本机账号与额度管理，不含联网中转或共享功能。</sub>
