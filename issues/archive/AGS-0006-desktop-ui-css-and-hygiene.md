# AGS-0006 · 桌面端样式双源冗余（CSP unsafe-inline）、原生菜单缺失与工程交互细节清理

- 状态：已关闭
- 类型：架构去冗余 / 界面体验与工程卫生
- 来源：2026-11-23 全量质检
- 环境：macOS 桌面端、Renderer 前端、打包配置、官网与文档

## 1. 现象与复现

1. **双源样式互相覆盖且迫使 CSP 放开 `'unsafe-inline'`**：[renderer/index.html](../../renderer/index.html) 内嵌 507 行 `<style>`，同时 [renderer/accounts.css](../../renderer/accounts.css) 维护 424 行外部样式，存在 37 个同名选择器二次覆盖、19 处同文件内重复选择器及十余处死规则，违背 [界面设计约定](../../docs/ui-design.md)「同一选择器同一属性只保留最终有效定义」，且迫使 CSP 保留 `style-src 'self' 'unsafe-inline'`。
2. **前端交互与弹窗状态细节问题**：
   - 批量导入成功时 [renderer/app.js](../../renderer/app.js) 第 `1466` 行传了 `'success'`（`showToast` 仅识别 `'ok'`），导致导入成功却弹出黄色警告三角图标并停留 6.5 秒；
   - [src/main.ts](../../src/main.ts) 第 `504-530`、`570-578` 行在文件选择框尚未确认前提前覆盖全局 `pendingImport`，点取消会冲掉此前已打开的导入预览；
   - `renderer/app.js` 弹窗可变状态散落为 16 个全局变量，跨 6 个关闭函数手工清零易遗漏；同时存在与 `account-policy.js` 重复的 `remaining()` 及无用的 `execCommand('copy')` 分支；
   - 首屏 `#viewTitle` HTML 写死 `Codex 调度中心` 启动闪烁为 `Codex 账号管理`，`#viewSub` 为死节点；窗口 `backgroundColor`（`#f8fafc`）与 `--bg`（`#f7f9fc`）微差；`logos.js` 在同文档多次注入重复 `id="gemini-grad-light"`；`private-browser.ts` 缺少 Arc / Vivaldi 等 macOS 常用 Chromium 浏览器无痕映射。
3. **macOS 左上角原生菜单未落地**：按 `Cmd+R` 会触发 Electron 默认整页重载白闪，而非刷新当前平台额度；打包态未收敛默认开发菜单快捷键。
4. **工程门禁、打包与仓库/官网冗余**：
   - `npm run lint` 漏检 `renderer/profile-name.js`；macOS 构建目标未排除 `assets/windows/**/*`；
   - 未跟踪的 `assets/icon-candidates/` 占 `17.0 MB`，需加入 `.gitignore` 或移出仓库；[联合返工与验收清单.md](https://github.com/xjzc-mt/agent-switcher/blob/365b774e796f046ccf55730d9cbe1a695a529249/docs/%E8%81%94%E5%90%88%E8%BF%94%E5%B7%A5%E4%B8%8E%E9%AA%8C%E6%94%B6%E6%B8%85%E5%8D%95.md) 已过时；
   - [site/app.js](../../site/app.js) 第 `30-140` 行重复硬编码 `site/index.html` 已有的 111 行默认中文文案，且第 `111` 行与 `site/index.html` 第 `406` 行的「Mac Antigravity 跨续期刷新仍待验证」滞后于 2026-11-21 实机验证结论。

## 2. 根因与修复方案

### 根因定位

1. 多轮紧凑 UI 迭代以追加样式块方式叠在 `accounts.css` 中，未反向清理 `index.html` 旧 `<style>`；弹窗功能逐步累加全局变量未做状态归并。
2. [navigation-menus.md](../../docs/navigation-menus.md) 已完成菜单职责设计但尚未在 `src/main.ts` 挂载 `Menu.setApplicationMenu`。
3. 官网国际化初期采用双份全量字典，未直接采集首屏 HTML 中文真源。

### 修复方案

1. **样式单一真源与 CSP 收紧**：移除 `renderer/index.html` 全部内联 `<style>`，与 `renderer/accounts.css` 去重合并为外部样式文件（同一选择器同一属性只留最终有效值，清除 `#viewSub`、`.badge-dot` 等死规则），将进度条动态宽度改为安全 DOM 属性/CSS 变量，把 CSP 收紧为 `style-src 'self'`。
2. **收口弹窗状态与修复交互小缺陷**：将 `app.js` 弹窗草稿状态收敛为单一 `activeDialog` 对象，删掉重复 `remaining()` 与 `execCommand('copy')`；修正 `showToast(..., 'ok')`、`main.ts` 文件选择后再提交 `pendingImport`、首屏标题、`#f7f9fc` 背景色、SVG 唯一渐变 ID，并在 `private-browser.ts` 补齐 Arc / Vivaldi Bundle ID。
3. **落地 macOS 原生应用菜单**：按 `docs/navigation-menus.md` 配置精简菜单（应用菜单含偏好设置 `Cmd+,` 与退出，动作含刷新额度 `Cmd+R` 与平台切换 `Cmd+1/2`，保留输入框必需的 `Edit` / `Window` 标准角色，打包版不暴露 `Reload` 与 `DevTools`）。
4. **工程、仓库与官网文档瘦身**：`package.json` `lint` 补入 `renderer/profile-name.js`，`build.mac` 排除 `assets/windows/**/*`；清理 `assets/icon-candidates/`（加 `.gitignore` 并移出仓库）与过时的 `docs/联合返工与验收清单.md`；精简 `docs/account-management.md` 与 `docs/refresh-behavior.md` 重复段落；重构 `site/app.js` 从 DOM 采集默认中文文案（删除重复 `I18N.zh`）并同步最新实机验证进展。

### 边界约束（不做什么）

- 严格保持现有紧凑视觉布局、字号、配色与卡片/单行几何尺寸不变（全部现有 `ui-layout` 等几何断言须原样通过）。

### 代码量基线与预估

当前工作区物理行数基线：业务源码 69 文件 / 15,189 行，测试 58 文件 / 10,803 行，开发脚本 5 文件 / 451 行，文档 20 文件 / 1,736 行。

| 类别 | 预计涉及文件 | 预计新增 | 预计删除 | 预计净变化 |
| --- | --- | ---: | ---: | ---: |
| 业务源码 | `renderer/index.html`、`renderer/accounts.css`、`renderer/app.js`、`renderer/logos.js`、`src/main.ts`、`src/private-browser.ts`、`site/app.js`、`site/index.html` | +240 ~ +320 | -650 ~ -780 | **-380 ~ -480** |
| 测试 | `tests/ui-chrome.cjs`、`tests/ui-credential-batch.cjs` | +25 ~ +45 | -5 ~ -15 | +15 ~ +35 |
| 开发脚本 | 无 | +0 | -0 | 0 |
| 文档 | `docs/navigation-menus.md`、`docs/ui-design.md`、`docs/account-management.md`、`docs/refresh-behavior.md`、删除 `docs/联合返工与验收清单.md` | +25 ~ +45 | -240 ~ -310 | **-200 ~ -270** |

### 验收标准

- [x] `renderer/index.html` 无 `<style>` 标签，CSP 为 `style-src 'self'`，控制台零 CSP 告警，全部 13 套 Electron UI 测试（含 `ui-layout` 像素几何断言）通过。
- [x] 批量导入成功显示绿色成功 Toast（3 秒）；文件对话框取消不破坏既有导入预览；macOS 下按 `Cmd+R` 触发额度刷新而不重载页面，输入框复制粘贴快捷键正常。
- [x] `npm run lint` 覆盖全部 `renderer/*.js`，`npm run site:build` 构建通过且中英文切换完整准确，`git status` 不含 `assets/icon-candidates/`。

## 3. 修复记录

2026-11-23，源码自测。

- 统一主窗口样式到外部 CSS，将 CSP 收紧为 `style-src 'self'`，额度条改用原生进度值。合并 35 组重复定义并清理 10 处被覆盖的样式。问题单列举的 `.badge-dot` 在本轮起点已经不存在。8 个界面状态逐个比对可见元素边界及抽查样式，全部一致，未见 CSP 告警。
- 弹窗草稿集中于 `activeDialog`，迟到的异步结果按所属弹窗丢弃。取消文件选择保留可用预览，显式取消能阻止在途读取重建预览。修正批量导入成功提示、首帧标题、背景和 SVG 渐变 ID；补入 Arc 与 Vivaldi 的私密窗口配置。
- 源码接入 macOS 原生菜单，`Cmd+R` 走现有刷新入口。隔离 Electron 验证菜单触发业务请求、页面保持原实例、模态框保护、系统编辑角色与设置入口；13 组 UI 用例含原布局几何断言全部通过。
- 官网从首屏 HTML 取得默认中文，离线浏览器验证中英往返、富文本及四组截图说明。macOS 和 Windows 的打包文件选择器分别核对过 Windows 辅助源码的排除和保留。图标候选移到仓库外并加入忽略，旧联合清单移出工作区，历史引用固定到对应提交。已同步设计、打包、导航及账号流程文档。

以本轮实际工作区为起点，四单共享文件按功能分摊后按编号对账。统计物理行，含空行和注释；配置单列。

| 类别 | 阶段前 | 新增 | 删除 | 净变化 | 阶段后 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 业务源码 | 15,451 | 1,026 | 1,042 | -16 | 15,435 |
| 测试 | 11,041 | 57 | 38 | +19 | 11,060 |
| 开发脚本 | 451 | 3 | 3 | +0 | 451 |
| 文档 | 2,079 | 36 | 171 | -135 | 1,944 |
| 配置 | 165 | 5 | 1 | +4 | 169 |

全量隔离自测：`npm run lint`、`npm test`、`npm run test:ui`、`npm run site:build` 通过。单测共 339 项，335 项通过，4 项仅适用于 Windows 或独立 macOS 用户的用例跳过，界面 13 套通过。

## 4. 验收记录

**2026-11-23 独立质检复核通过，问题关闭。**

- **代码、视觉与配置复核**：
  1. `renderer/index.html` 已由 669 行精简至 161 行，全量扫描 `renderer/` 确认零 `<style>`、零 `style=` 属性与零 `cssText`；CSP 已收紧为 `style-src 'self'`，额度进度条改用 `<progress class="quota-track">`，13 套 UI 测试在严格控制台错误捕获下零告警通过。
  2. 弹窗可变草稿已收敛至 `activeDialog`（带 `generation` 隔离迟到响应）；批量导入成功 Toast 修正为 `'ok'`；`main.ts` 通过 `beginImportPreview()` 确保文件选择框取消时不冲掉既有导入预览；首屏 `#viewTitle`、窗口背景 `#f7f9fc`、按 `slot` 区分的 SVG 渐变 ID 以及 Arc / Vivaldi 私密窗口映射均已就位。
  3. 新增 `src/application-menu.ts` 挂载 macOS 原生菜单栏，`Cmd+R` 走业务刷新且不重载文档，模态弹窗打开时自动禁用切换/刷新菜单项，打包模式不暴露 `Reload` 与 `DevTools`（`tests/ui-chrome.cjs` 实跑验证通过）。
  4. `package.json` `lint` 已覆盖 `renderer/profile-name.js`，`build.mac.files` 已排除 `!assets/windows/**/*`；`assets/icon-candidates/` 已移出工作区并写入 `.gitignore`；过时清单已清理且全仓 Markdown 相对链接扫描确认 **0 死链**；`site/app.js` 已从首屏 DOM 自动提取静态中文真源（净减 89 行）并同步 Mac 实机跨期验证说明，`npm run site:build` 构建通过。
