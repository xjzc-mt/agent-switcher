import fs from 'node:fs';
import path from 'node:path';

// Package family is stable across Store updates and CPU architectures.
export const CODEX_STORE_FAMILY = 'OpenAI.Codex_2p2nqsd0c76g0';
const storePackageRoot = (local: string) => path.join(local, 'Packages', CODEX_STORE_FAMILY);

export function missingWindowsCodexRuntime(): string | undefined {
  const local = process.env.LOCALAPPDATA;
  if (!local || !path.isAbsolute(local)) return;
  try {
    if (fs.statSync(storePackageRoot(local), { throwIfNoEntry: false })?.isDirectory())
      return '未找到 Codex 桌面的运行组件。请打开 Codex，确认能正常启动后再刷新；若仍失败，请在 Microsoft Store 更新或修复 Codex。';
  } catch { /* A package directory that cannot be observed does not establish installation. */ }
}

/** npm's Windows shim wraps the same native CLI. Start it directly so the
 * isolated process owns its pipes and PID even when the path contains spaces. */
export function findWindowsCodexBinary(directories?: string[], arch = process.arch): string | undefined {
  function isFile(file: string) {
    try { return fs.statSync(file, { throwIfNoEntry: false })?.isFile(); }
    catch { return false; }
  }
  const local = process.env.LOCALAPPDATA;
  const configured = process.env.CODEX_CLI_PATH?.trim().replace(/^"(.*)"$/, '$1');
  if (!directories && configured && path.isAbsolute(configured) && /\.exe$/i.test(configured) && isFile(configured)) return configured;
  for (const entry of directories ?? [
    ...(process.env.PATH || '').split(';'),
    ...(process.env.CODEX_INSTALL_DIR ? [process.env.CODEX_INSTALL_DIR] : []),
    ...(local ? [path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin')] : []),
    ...(process.env.APPDATA ? [path.join(process.env.APPDATA, 'npm')] : []),
  ]) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!path.isAbsolute(dir)) continue;
    const exe = path.join(dir, 'codex.exe');
    if (isFile(exe)) return exe;
    if (!isFile(path.join(dir, 'codex.cmd')) || (arch !== 'x64' && arch !== 'arm64')) continue;
    const modules = path.basename(dir).toLowerCase() === '.bin' ? path.dirname(dir) : path.join(dir, 'node_modules');
    const cli = path.join(modules, '@openai', 'codex');
    if (!isFile(path.join(cli, 'bin', 'codex.js'))) continue;
    const architectures = [arch];
    if (arch === 'x64' && [process.env.PROCESSOR_ARCHITEW6432, process.env.PROCESSOR_ARCHITECTURE]
      .some(value => value?.toUpperCase() === 'ARM64')) architectures.push('arm64');
    for (const candidate of architectures) {
      const platformPackage = path.join('@openai', 'codex-win32-' + candidate);
      const triple = (candidate === 'x64' ? 'x86_64' : 'aarch64') + '-pc-windows-msvc';
      for (const pkg of [path.join(cli, 'node_modules', platformPackage), path.join(modules, platformPackage), cli]) {
        for (const subdir of ['bin', 'codex']) {
          const binary = path.join(pkg, 'vendor', triple, subdir, 'codex.exe');
          if (isFile(binary)) return binary;
        }
      }
    }
  }
  if (directories || !local || !path.isAbsolute(local)) return;
  let newest: { file: string; timestamp: number } | undefined;
  for (const parent of [local, path.join(storePackageRoot(local), 'LocalCache', 'Local')]) {
    const cache = path.join(parent, 'OpenAI', 'Codex', 'bin');
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(cache, { withFileTypes: true }); } catch { continue; }
    // Desktop releases use either a flat cache or a finalized hash directory.
    const versions = entries.filter(e => e.isDirectory() && /^[a-f0-9]{16}$/i.test(e.name)).map(e => e.name);
    for (const version of ['', ...versions.sort()]) {
      const file = path.join(cache, version, 'codex.exe');
      try {
        const stat = fs.lstatSync(file, { throwIfNoEntry: false });
        if (stat?.isFile() && (!newest || stat.mtimeMs > newest.timestamp)) newest = { file, timestamp: stat.mtimeMs };
      } catch { /* Desktop updates can remove a candidate during discovery. */ }
    }
  }
  return newest?.file;
}
