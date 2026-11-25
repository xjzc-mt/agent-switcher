# AGS-0017 · 免下载远程元数据离线签名与一键发布脚本

- 状态：已关闭
- 发现日期：2026-11-25
- 关闭日期：2026-11-25
- 平台：全平台（维护者发布工具链）
- 来源：local（发布流程提速与供应链安全兼顾）

## 1. 现象与复现

1. 现有 [scripts/release-checksums.cjs](../../scripts/release-checksums.cjs) 仅支持对本地磁盘上的 `.dmg` / `.exe` 安装包逐字节读取计算 SHA-256 并生成 `.signed.json`。
2. 每次 GitHub Actions 三端打包上传至 Release 草稿后，维护者必须先将约 360 MB 的三个安装包全部拉回本地才能执行离线 Ed25519 签名，耗时长且浪费带宽；但若将发布私钥直接放入云端普通 Secret，又会降低更新信任根的供应链隔离强度。

## 2. 根因与修复方案

### 根因定位
[src/release-manifest.ts](../../src/release-manifest.ts) `releaseSigningBytes()` 实际只对 `['com.agent-switcher.app/release/v1', version, name, size, sha256]` 元数据签名，并不依赖安装包原始字节流；而 GitHub Releases API 已提供各已上传产物的精确 `size` 与 `digest (sha256:...)`。

### 修复方案
1. 扩展 [scripts/release-checksums.cjs](../../scripts/release-checksums.cjs) 支持 `--github-release vX.Y.Z [--commit <sha>] [--publish]` 免下载远程签名模式（保留原有本地文件签名模式兼容），并在 [package.json](../../package.json) 增加 `npm run release:sign` 入口：
   - 校验本机离线 Ed25519 私钥与仓库内置 `assets/release-signing-public.pem` 匹配，拒绝已退役版本号 `1.0.0` / `1.0.1`；
   - 通过 `gh api` 核对目标 Release 的 `target_commitish` 与本地 `HEAD`（或 `--commit` 指定 40 位 SHA）完全一致，且该提交存在已成功完成的 `release-build.yml` 构建记录；
   - 直接读取三端安装包的 `size` 与 `sha256:` 摘要，在 `0700` 临时目录生成并通过 `verifyReleaseManifest` 自检 `SHA256SUMS` 与 3 份 `.signed.json`，通过 `gh release upload --clobber` 上传覆盖；传入 `--publish` 时一并取消草稿并设为 `Latest`。
2. 在 [tests/app-updates.test.cjs](../../tests/app-updates.test.cjs) 新增正常签名发布与异常拦截回归测试，并同步更新 [docs/releasing.md](../../docs/releasing.md)。

### 边界约束（不做什么）
- 私钥继续严格保存在仓库外本机路径，不上传至 GitHub Secrets，也不在仓库硬编码任何本机私钥路径。

### 代码量基线与预估（物理行数）

| 类别 | 相关文件基线 | 预计新增 | 预计删除 | 预计净变化 |
| --- | --- | --- | --- | --- |
| 业务源码 | `package.json` (105)，全仓 17,209 | +1 ~ +2 | 0 | +1 ~ +2 |
| 开发脚本 | `scripts/release-checksums.cjs` (57)，全仓 739 | +65 ~ +85 | -15 ~ -25 | +45 ~ +65 |
| 测试 | `tests/app-updates.test.cjs` (482)，全仓 11,990 | +45 ~ +70 | 0 ~ -5 | +45 ~ +65 |
| 文档与问题单 | `docs/releasing.md` (49)、`issues/README.md` (58) 及本单，全仓 2,863 | +55 ~ +80 | -8 ~ -16 | +45 ~ +68 |

### 验收清单
- [x] `npm run release:sign -- --github-release vX.Y.Z` 无需下载安装包即可完成提交核验、流水线核验、离线签名自检、清单覆盖上传与可选 `--publish`。
- [x] 原有本地文件 `release:checksums` 模式保持兼容；`npm run lint` 与 `app-updates.test.cjs` 全量通过。

## 3. 修复记录

- 2026-11-25：完成 `scripts/release-checksums.cjs` 免下载远程签名发布模式、`package.json` `release:sign` 脚本、`tests/app-updates.test.cjs` 单元测试与 `docs/releasing.md` 文档更新。
- 全仓同口径物理行数对账：业务源码 17,209／+1／0／+1／17,210，开发脚本 739／+125／-34／+91／830，测试 11,990／+57／0／+57／12,047，文档与问题单 2,863／+62／-7／+55／2,918。开发脚本净增高于初估（+91 vs +65）是因为额外加入了 `release-build.yml` 成功构建记录溯源校验与上传前 `verifyReleaseManifest` 本地自检。

## 4. 验收记录

- **验收日期与结论**：2026-11-25，**免下载远程签名、提交与打包溯源拦截、原本地模式兼容及全套自动化测试核验通过，准予关闭归档**。
- **核验要点**：
  1. **防篡改与溯源闭环**：对已退役版本、`target_commitish` 不一致、`release-build.yml` 未成功、缺失任一平台安装包或缺失 `sha256:` 摘要共 5 类异常均在写入/上传前准确拒绝；正常路径生成的 `SHA256SUMS` 与 3 份 `.signed.json` 全部通过 `verifyReleaseManifest` 校验并清理临时目录。
  2. **回归测试**：`npm run lint`、`tests/app-updates.test.cjs`（18 项全过，含原有本地文件签名测试与新增免下载远程签名测试）一次通过。
