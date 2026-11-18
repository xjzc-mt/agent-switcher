#!/usr/bin/env node
'use strict';

// Read-only: inspect sizes without following symlinks or reading account data.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
let json = false, appPath;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--json') json = true;
  else if (args[i] === '--app' && args[i + 1]) appPath = path.resolve(args[++i]);
  else {
    console.error('用法：npm run size:audit -- [--json] [--app /path/to/AgentSwitcher.app]');
    process.exit(1);
  }
}

function measure(file) {
  if (!fs.existsSync(file)) return { bytes: 0, diskBytes: 0, files: 0 };
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) return { bytes: 0, diskBytes: 0, files: 0 };
  const size = { bytes: stat.isFile() ? stat.size : 0, diskBytes: stat.blocks * 512, files: stat.isFile() ? 1 : 0 };
  if (stat.isDirectory()) {
    for (const item of fs.readdirSync(file)) {
      const child = measure(path.join(file, item));
      for (const key of Object.keys(size)) size[key] += child[key];
    }
  }
  return size;
}

function findApps(dir, depth = 0) {
  if (!fs.existsSync(dir) || depth > 3) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => {
    if (!item.isDirectory()) return [];
    const file = path.join(dir, item.name);
    return item.name.endsWith('.app') ? [file] : findApps(file, depth + 1);
  });
}

function inspectApp(file) {
  if (!fs.existsSync(path.join(file, 'Contents', 'Info.plist'))) throw new Error(`不是 macOS .app：${file}`);
  const contents = path.join(file, 'Contents');
  const localesDir = path.join(contents, 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources');
  const localeNames = fs.existsSync(localesDir) ? fs.readdirSync(localesDir).filter(name => name.endsWith('.lproj')) : [];
  const locales = localeNames.reduce((total, name) => total + measure(path.join(localesDir, name)).bytes, 0);
  return {
    path: file,
    ...measure(file),
    frameworks: measure(path.join(contents, 'Frameworks')),
    appAsar: measure(path.join(contents, 'Resources', 'app.asar')),
    locales: { count: localeNames.length, bytes: locales },
  };
}

const mib = bytes => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
try {
  const folders = fs.readdirSync(root, { withFileTypes: true })
    .filter(item => item.isDirectory())
    .map(item => ({ name: item.name, ...measure(path.join(root, item.name)) }))
    .sort((a, b) => b.diskBytes - a.diskBytes);
  const report = {
    workspace: root,
    total: measure(root),
    folders,
    electronSdk: measure(path.join(root, 'node_modules', 'electron')),
    apps: (appPath ? [appPath] : findApps(path.join(root, 'release'))).map(inspectApp),
  };
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`工作目录：${report.workspace}`);
    console.log(`总磁盘占用 ${mib(report.total.diskBytes)}；文件内容 ${mib(report.total.bytes)}`);
    console.log('\n目录                          磁盘占用          文件内容');
    for (const row of folders) console.log(`${row.name.padEnd(28)} ${mib(row.diskBytes).padStart(14)} ${mib(row.bytes).padStart(17)}`);
    console.log(`\n开发用 Electron SDK：${mib(report.electronSdk.diskBytes)}（不额外分发到 .app）`);
    for (const app of report.apps) {
      console.log(`\n应用：${app.path}`);
      console.log(`  磁盘占用 ${mib(app.diskBytes)}；文件内容 ${mib(app.bytes)}`);
      console.log(`  Electron 等框架 ${mib(app.frameworks.bytes)}；业务代码与运行依赖 app.asar ${mib(app.appAsar.bytes)}`);
      console.log(`  框架语言资源 ${app.locales.count} 份，${mib(app.locales.bytes)}`);
    }
    console.log('\n开发目录 ≠ 已安装应用 ≠ 压缩安装包。此命令只检查体积，不删除任何文件。');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
