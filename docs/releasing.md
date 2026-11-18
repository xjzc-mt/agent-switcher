# 构建与发布

首版分发 macOS Apple Silicon 的 DMG。面向用户的功能、安装说明和兼容范围见[首发说明](release-1.0.0.md)。

## 构建候选版本

在 Apple Silicon Mac 上核对 `package.json`、锁文件根版本与预定标签。例如，版本 `1.0.0` 对应标签 `v1.0.0`。从同一提交构建并校验：

```bash
npm ci
npm run lint
npm test
npm run test:ui
npm run dist
npm run release:checksums -- release/AgentSwitcher-1.0.0-arm64.dmg
(cd release && shasum -a 256 -c SHA256SUMS)
hdiutil verify release/AgentSwitcher-1.0.0-arm64.dmg
```

UI 回归使用演示账号。界面发生变化时，先用 `npm run screenshots` 更新[截图](images/README.md)，再固定构建提交。

## 检查安装包

只读挂载 DMG，将应用复制到测试目录。核对版本、架构、应用图标及菜单栏图标，对复制出的应用运行 `codesign --verify --deep --strict`。当前使用 ad-hoc 签名，安装说明须准确说明签名和公证状态。

在独立的 macOS 用户或干净机器上按默认方式启动应用，验证账号页、设置和正常退出。使用演示凭据检查登录、额度、切换、导入和备份。

## 发布稳定版

1. 将草稿指向构建安装包的提交。Assets 使用 `AgentSwitcher-1.0.0-arm64.dmg` 和同批 `SHA256SUMS`，核对文件名、大小及 SHA-256。草稿正文中的文档链接应指向该版本源码。
2. 核对安装说明和对应提交的 CI，完成安装验收后发布稳定版。正式标签指向已验收的提交。
3. 从公开 Release 匿名下载安装包和校验文件，按用户步骤验证下载、校验与安装。从较旧的受支持版本验证应用内更新入口。
4. 已发布版本如有安装或凭据问题，保留可追溯的原包并发布新版本。需要回退账号池时，通过独立密码保护的 `.ags` 备份恢复，详见[账号管理](account-management.md)。
