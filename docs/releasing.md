# 构建与发布

[0.1.0](release-0.1.0.md) 分发 macOS Apple Silicon、Intel 两种 DMG 及 Windows x64 安装程序，并在官网托管 `install.sh` / `install.ps1` 一键安装脚本。版本基线、源码验收和待测环境见[当前待办](当前待办.md)。早期测试版资料保留在 [1.0.1](release-1.0.1.md) 与 [1.0.0](release-1.0.0.md)。

## 版本与提交

1. 自 `v0.1.0` 起公开版本号统一采用 `0.1.x` 系列；早期 `v1.0.0`、`v1.0.1` 在 GitHub Releases 标记为预发布（Pre-release）归档，新版本发布时必须显式勾选 `Set as the latest release`（`gh release edit v0.1.0 --latest`）。后续版本在包清单和锁文件中使用同一版本号。应用按三段数字比较版本并排除已退役的 `1.0.0`、`1.0.1`。[更新器](../src/app-updates.ts)
2. 固定候选提交前核对 `git status --short --untracked-files=all`，特别检查新主进程模块、小菜单页面与预加载、公钥、官网和验收用例。用该提交的干净检出构建，避免现有工作区或陈旧 `dist/` 掩盖漏交的文件。体验记录留存源码构建标识、平台及对应提交。
3. 确定发布范围时，在候选提交同步应用版本、锁文件根版本、发布说明和下载入口。每个对外版本的标签、平台产物及校验文件对应同一提交。若 Windows 修复晚于已发 macOS 版本且需要改源码，给后续发布分配下一个版本号。
4. 保留旧版支持的 `SHA256SUMS`，同时为新版更新器提供 `.signed.json` 发布清单。旧版固定查询当前仓库。若发布入口迁移，需在官网提供首次手动升级路径，并将新版更新器指向公开发布入口。

## 构建与免下载签名发布

在构建前核对 `package.json`、锁文件根版本与预定标签。在 GitHub 创建指向完整 40 位提交 SHA 的 Release 草稿，触发 [Build release installers](../.github/workflows/release-build.yml)。三个原生 runner 从该提交打包、安装自检成功后，直接写入版本与提交均匹配的草稿。

构建完成后**无需将数百 MB 安装包拉回本地**：在保管私钥的本机运行 `npm run release:sign`，脚本会核对 Release 草稿的 `target_commitish`、核验该提交存在已成功的 `release-build.yml` 构建记录，直接读取 GitHub 已计算的字节大小与 `sha256` 摘要，在本地秒级生成并自检 `SHA256SUMS` 与 3 份 `.signed.json` 上传覆盖，加 `--publish` 时一并发布并设为 `Latest`：

```bash
npm ci
npm run lint
npm test
npm run test:ui
npm run release:sign -- --sign-key /path/to/offline-private.pem --github-release v0.1.1 --publish
```

（若已在本机环境配置 `AGS_RELEASE_SIGN_KEY`，可省略 `--sign-key`；若需对本地离线安装包文件计算哈希并签名，仍可使用 `npm run release:checksums -- --sign-key /path/to/offline-private.pem release/*.dmg release/*.exe`。）

Windows 源码开发运行 `npm run build` 时会调用系统 .NET Framework C# 编译器生成桌面和凭据辅助程序。构建 Windows 安装包时，electron-builder 从当前源码重新编译，按已配置的 Windows 签名选项处理文件，再将 SHA-256 写入应用归档。macOS 或 Linux 交叉构建 Windows 目标需在构建机上提供 Mono 的 `mcs`。

UI 回归使用演示账号。界面发生变化时，先用 `npm run screenshots` 更新[截图](images/README.md)，再固定构建提交。

### 发布密钥

客户端的信任起点是项目内的 `assets/release-signing-public.pem`（Ed25519 SPKI 公钥）。保管相应的 PKCS#8 私钥及独立备份，将私钥留在仓库和构建输出目录之外。签名脚本会比对公钥，只在输出目录写入校验文件与签名清单。执行签名时传入本地密钥文件路径。

仅生成手动校验文件可运行原命令 `npm run release:checksums -- 路径/安装包.dmg`。轮换密钥时，先构建内置新公钥的过渡版本，从固定旧公钥的上一版源码目录，用旧私钥为过渡版本签名。保留过渡版的手动下载入口，后续版本使用新密钥签名。旧私钥遗失或泄露时，通过可信渠道重新分发内置新公钥的安装包。

## 检查安装包

只读挂载 DMG，将应用复制到测试目录。核对版本、架构、Info.plist 最低系统版本、应用图标及菜单栏图标，对复制出的应用运行 `codesign --verify --deep --strict`。当前使用 ad-hoc 签名，安装说明须准确说明签名和公证状态。

在独立的 macOS 用户或干净机器上按默认方式启动应用，验证账号页、设置和正常退出。使用演示凭据检查登录、额度、切换、导入和备份。

## 发布稳定版

AGS 将 GitHub Release 正文作为纯文本显示在「更新说明」里。正文只写用户能感知的主要变化，每条一句。安装包放在 Release 附件，下载入口、最低系统要求和安装步骤放在 README 与官网，详细变更和验证范围记入该版本的说明文档。

1. 为待发布版本新建指向完整提交 SHA 的草稿并运行 `release-build.yml`，待三端安装包与 CI 全绿后执行 `npm run release:sign -- --github-release v0.1.x --publish` 上传 `.signed.json` 与 `SHA256SUMS` 并设为 `Latest`。
2. 核对安装说明和对应提交的 CI，完成安装验收后发布稳定版。正式标签指向已验收的提交。
3. 匿名访问 Pages 与公开 Release，验证中英文页面的下载、校验与安装。从较旧的受支持版本验证应用内更新。Pages 发布源使用 GitHub Actions。部署完成后核对中英文主页、README 入口与三个安装包链接。
4. 已发布版本如有安装或凭据问题，保留可追溯的原包并发布新版本。回退账号池须使用目标版本可读取的备份；回退到初始 v1.0.0 时，使用升级前保留的 AGS1 备份。详见[账号管理](account-management.md)。
