# 打包与体积

开发目录、已安装应用和压缩后的 DMG 是不同对象，不能把整个工作区体积当作下载大小。

- `node_modules/` 是开发与构建依赖，其中包含开发用 Electron。
- `dist/` 是 TypeScript 编译结果。
- `release/` 是安装包和打包中间产物。
- `test-results/` 是测试截图等生成文件。

这些目录均不进入 Git。Electron 应用仍需要自己的 Chromium/Node 运行时，删除业务文档和截图不会大幅缩小运行时。

## 当前打包配置

`package.json` 的 `build.files` 纳入项目 MIT 许可 `LICENSE`、`dist/**/*.js`、`renderer/**/*` 和运行时 `assets/**/*`，排除备选图标目录 `assets/icon-candidates/**/*`。electron-builder 同时收集必要运行依赖。`build.mac.icon` 另从 `packaging/app-icon.png` 生成应用图标，该文件也是开发版 Dock 图标来源。默认生成 DMG，不自动上传。语言资源保留英文与简繁体中文及相应变体。应用标识固定为 `com.agent-switcher.app`。

```bash
npm run dist
npm run dist:dir
npm run dist:zip
npm run size:audit
npm run size:audit -- --app /path/to/AgentSwitcher.app
npm run size:audit -- --json
```

`size:audit` 只读取项目和指定安装包的体积，不遍历账号目录或删除文件。发布构建、校验与签名验收见[发布流程](releasing.md)；正式附件以对应 Release 为准。
