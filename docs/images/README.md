# 使用截图

这些图片由实际 Electron 界面拍摄，使用虚构账号、`example.test` 邮箱与模拟额度；不是线上账号、服务端响应或安全审计的证明。界面布局与文案来自当前 `renderer/`，没有另画或修改截图。

演示包含自己的日常账号，以及获授权使用的同事、朋友和小组协作账号；展示的是本机账号管理与切换，不表示本版提供共享服务、账号同步或多人并发控制。

在 macOS 的图形桌面环境中安装开发依赖后重新生成：

```bash
node_modules/.bin/electron scripts/capture-screenshots.cjs
```

脚本复用 `tests/fixture-preload.cjs` 和隔离浏览器数据目录，在 macOS 上为 Chromium 启用模拟钥匙串。演示资料由夹具提供，外部网络请求和新窗口均被阻止，退出后清理临时浏览器数据。截图为生成文件，不计入源码行数。

| 图片 | 展示场景 |
| --- | --- |
| `01-codex-cards.png` | 当前账号、套餐分组、剩余额度与切换入口 |
| `02-codex-rows.png` | 紧凑单行账号列表与额度比较 |
| `03-antigravity.png` | Gemini 与 Claude / GPT 等模型组额度 |
| `04-add-account.png` | 独立登录后核对邮箱、命名与连续添加 |
| `05-import-preview.png` | 批量导入预览、命名、重复项与无效项提示 |
| `06-encrypted-backup.png` | 多账号选择与密码加密备份 |
| `07-remove-confirmation.png` | 移除范围核对、默认保留客户端登录 |
| `08-settings.png` | 1.0.1 显示偏好、清理指令、应用更新与导出故障报告 |

设置图保留「尚未检查新版」，不伪造可下载的未来版本。截图中的密码为演示值；实际使用请自行设置并妥善保存备份密码。
