# AGS-0016 · 版本体系回调至 0.1.0、历史 1.0.x 防回跳与官网跨平台一键安装脚本

- 状态：已关闭
- 发现日期：2026-11-25
- 关闭日期：2026-11-25（`v0.1.0`）
- 平台：macOS（Apple Silicon / Intel）、Windows x64
- 来源：local（版本发布与安装体验完善）

## 1. 现象与复现

1. 早期测试阶段使用了 `1.0.0` / `1.0.1` 版本号，与产品当前演进阶段不符，维护者决定从本版起将公开版本体系回调为 **`0.1.0`**，后续按 `0.1.x` 演进并统一走应用内一键更新（[AGS-0012](AGS-0012-seamless-in-app-update-install.md)）。
2. 直接回调至 `0.1.0` 存在两个实际问题：
   - 若旧用户本地 `app-updates.json` 仍缓存过 `1.0.1` 记录，或线上误读到历史 `1.0.x` 标签，客户端按数字比较 `1.0.1 > 0.1.0` 会反向提示“升级”回已退役的 `1.0.1`；
   - 普通首次安装用户（及从 `1.0.1` 切回 `0.1.0` 的老用户）尚无零门槛的一行终端安装方式，需手动辨别芯片架构、下载挂载 DMG 并处理首次打开隔离提示。

## 2. 根因与修复方案

### 根因定位
1. [src/app-updates.ts](../../src/app-updates.ts) 与 [site/app.js](../../site/app.js) 仅按纯三段数字比较版本大小，未排除已退役的早期测试版号 `1.0.0`、`1.0.1`。
2. [site/](../../site) 与 [scripts/build-site.cjs](../../scripts/build-site.cjs) 仅输出静态网页与截图，尚未托管自动识别架构、核对发布清单与 SHA-256 并装入用户可写标准目录（衔接后续应用内自替换更新）的一键安装脚本。

### 修复方案
1. **版本号归位与历史 `1.0.0`/`1.0.1` 防回跳**：
   - 将 [package.json](../../package.json) 与 `package-lock.json` 根版本统一改为 `0.1.0`；
   - 在 [src/app-updates.ts](../../src/app-updates.ts)、[site/app.js](../../site/app.js) 及安装脚本中显式排除已退役的 `1.0.0` 与 `1.0.1` 远端/缓存目标版本；发布时将线上 `v1.0.0`、`v1.0.1` 标为 `prerelease`/`draft` 并将 `v0.1.0` 显式设为 `Latest`。
2. **官网托管跨平台一键安装脚本（无缝衔接应用内更新）**：
   - [site/install.sh](../../site/install.sh)（macOS）：自动识别 Apple Silicon / Intel（兼容 Rosetta 终端），查询 `/releases/latest` 获取正式版 DMG 与同名 `.signed.json` 清单，核对元数据、GitHub `digest`、字节长度、SHA-256 与应用包 `codesign --verify --deep --strict`，只读挂载并原子安装/替换至 `/Applications/AgentSwitcher.app`（无写权限时回退 `~/Applications`；若旧版运行中则请求正常退出等待 `quitGuard` 排空），清理下载隔离属性并启动应用；
   - [site/install.ps1](../../site/install.ps1)（Windows x64）：查询 `/releases/latest`，下载 `AgentSwitcher-Setup-<version>-x64.exe` 与 `.signed.json`，核对字节长度与 SHA-256 后调用 NSIS `/S --force-run` 用户级覆盖安装并拉起新版；
   - 在 [scripts/build-site.cjs](../../scripts/build-site.cjs) 将 `install.sh`、`install.ps1` 纳入 Pages 构建产物，并在官网与中英文 README 提供复制命令入口。

### 边界约束（不做什么）
- 不引入第三方安装器框架或包管理器仓库，保持 GitHub Releases + GitHub Pages 纯静态零后端架构。
- 安装脚本遇到正在运行的旧版 AGS 时只发正常退出请求等待安全落盘，绝不 `kill -9` 强杀进程。

### 代码量基线与预估（物理行数）

| 类别 | 相关文件基线 | 预计新增 | 预计删除 | 预计净变化 |
| --- | --- | --- | --- | --- |
| 业务源码与官网 | `package.json` (105)、`src/app-updates.ts` (366)、`site/index.html` (616)、`site/app.js` (470)，新增 `site/install.sh`、`site/install.ps1`（合计 1,557） | +190 ~ +250 | -15 ~ -30 | +170 ~ +225 |
| 开发脚本 | `scripts/build-site.cjs` (61) | +2 ~ +6 | -1 ~ -3 | +1 ~ +4 |
| 测试 | `tests/app-updates.test.cjs` (471)、`tests/site-build.test.cjs` (114)（合计 585） | +70 ~ +120 | -5 ~ -15 | +60 ~ +110 |
| 文档与问题单 | `README.md` (163)、`README.en.md` (163)、`docs/app-updates.md` (40)、`docs/releasing.md` (49)、`issues/README.md` (57)，新增 `docs/release-0.1.0.md` 与本单（合计 472） | +110 ~ +160 | -25 ~ -45 | +80 ~ +120 |

### 验收清单
- [x] `package.json` 与 `package-lock.json` 版本号均为 `0.1.0`，演示截图同步更新为 `0.1.0` 最新界面。
- [x] 更新器与官网对缓存或接口返回的 `1.0.0`/`1.0.1` 均不视为可升级新版，而对 `0.1.1`+ 正常识别更新。
- [x] `build-site.cjs` 输出包含 `install.sh` 与 `install.ps1`；隔离测试使用本地合成 DMG 验证 `install.sh` 的哈希校验、损坏拦截、首次安装与旧包保留数据替换。
- [x] `npm run lint`、`npm test`、`npm run test:ui`、`npm run site:build` 全部通过；完成 `v0.1.0` 三端构建、Ed25519 签名上传与 `Latest` 正式发布。

## 3. 修复记录

- 2026-11-25：将 `package.json` 与 `package-lock.json` 版本号切换为 `0.1.0`；在 `src/app-updates.ts`、`site/app.js` 与双平台安装脚本中排除已退役的 `1.0.0`/`1.0.1` 版本号，防止旧缓存或历史标签导致回跳。
- 新增 `site/install.sh` 与 `site/install.ps1`，接入 `scripts/build-site.cjs`、官网双语安装区、中英文 `README` 及 `docs/release-0.1.0.md`，并重新生成 `0.1.0` 演示截图。
- 在 GitHub Actions 双平台 CI 与三端打包联验中一并收敛了跨平台兼容细节：`scripts/check-packaged-app.cjs` Windows `asar` 路径分隔符、`src/store.ts` NTFS `fchmodSync` 平台判断、`tests/windows-sessions.test.cjs` 8.3 短路径解析、`tests/ui-chrome.cjs` 与 `tests/ui-support.cjs` 虚拟机时序稳定性，以及 [assets/windows/QuotaProcess.cs](../../assets/windows/QuotaProcess.cs) 标准用户受限令牌沙箱的短槽位目录、文件级强制完整性标签、`Everyone`/`RESTRICTED`/登录会话受限 SID 与查询级 `TokenDefaultDacl`；并在线上实测后为 `install.sh`/`install.ps1` 邻接中文标点的变量插值补齐 `${...}` 花括号（含 `LC_ALL=C` `/bin/bash` 回归断言）。
- 全仓同口径物理行数对账（以本轮会话开始工作区为基线，不含锁文件、二进制截图与构建产物）：业务源码与官网 16,924／+338／-53／+285／17,209，开发脚本 739／+2／-2／0／739，测试 11,901／+103／-14／+89／11,990，文档与问题单 2,759／+143／-39／+104／2,863。业务增量高于初估（+285 vs +225）主要来自 `install.sh` 运行中旧版安全退出等待逻辑及 GitHub Actions Windows 标准用户沙箱联验修复（`QuotaProcess.cs` 净增 +16 行）。

## 4. 验收记录

- **验收日期与结论**：2026-11-25，**`v0.1.0` 正式版三端安装包构建、离线 Ed25519 签名、`Latest` 发布与线上跨平台安装链路全部实测通过，准予关闭归档**。
- **发布与验证凭据**：
  1. **构建提交与流水线**：发布提交 `fb1853d8bdcde9b9d924247bb94a5b7410821744`；双平台 CI（Run `45550405643`，含 macOS 全套测试 + Electron UI 及 Windows 标准用户原生沙箱隔离测试）与三端打包流水线（Run `45550417208`，`macos-15` arm64、`macos-15-intel` x64、`windows-latest` NSIS x64）全部绿灯通过。
  2. **离线签名与正式发布**：使用仓库外离线 Ed25519 私钥生成并通过 `verifyReleaseManifest` 校验 3 份 `.signed.json` 清单与 `SHA256SUMS`，上传至 `v0.1.0`（共 7 个资产）；`v1.0.1` 保持 `Pre-release`，`v0.1.0` 设为正式 `Latest`（`/releases/latest` 实测返回 `tag_name: "v0.1.0"`）。
  3. **线上安装实测与 Issue 闭环**：实测执行 `curl -fsSL https://xjzc-mt.github.io/agent-switcher/install.sh | bash` 下载线上 DMG、核对 `.signed.json` 与 SHA-256、验证 `codesign --verify --deep --strict` 并装入目标目录（`CFBundleShortVersionString = 0.1.0`）；同步汇总回复并关闭线上关联 GitHub Issues `#1` 与 `#3`。
