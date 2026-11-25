'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { buildSite } = require('../scripts/build-site.cjs');

const ROOT = path.resolve(__dirname, '..');

test('buildSite outputs all referenced local assets and images', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-site-'));
  try {
    const existing = path.join(tmpDir, 'index.html');
    fs.writeFileSync(existing, 'existing project');
    assert.throws(() => buildSite(tmpDir), /已有文件已保留/);
    assert.equal(fs.readFileSync(existing, 'utf8'), 'existing project');
    fs.unlinkSync(existing);
    buildSite(tmpDir);
    fs.writeFileSync(path.join(tmpDir, '.nojekyll'), ''); // A pre-1.0.1 build can be rebuilt in place.
    buildSite(tmpDir);

    assert.equal(fs.existsSync(path.join(tmpDir, '.nojekyll')), true);
    assert.equal(fs.existsSync(path.join(tmpDir, 'install.sh')), true);
    assert.equal(fs.existsSync(path.join(tmpDir, 'install.ps1')), true);
    const html = fs.readFileSync(path.join(tmpDir, 'index.html'), 'utf8');
    const appJs = fs.readFileSync(path.join(tmpDir, 'app.js'), 'utf8');

    const localRefs = [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map((m) => m[1]);
    assert.ok(localRefs.length > 0, 'Expected local relative asset references in index.html');
    for (const ref of localRefs) {
      assert.equal(fs.existsSync(path.join(tmpDir, ref)), true, `Missing built asset: ${ref}`);
    }

    const shotRefs = [...html.matchAll(/data-shot="([^"]+)"/g)].map((m) => m[1]);
    const stageRefs = [...appJs.matchAll(/file:\s*'([^']+\.png)'/g)].map((m) => m[1]);
    for (const imgName of new Set([...shotRefs, ...stageRefs])) {
      assert.equal(
        fs.existsSync(path.join(tmpDir, 'images', imgName)),
        true,
        `Missing screenshot in site build: ${imgName}`
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('site i18n keys match across zh, en, and index.html', () => {
  const html = fs.readFileSync(path.join(ROOT, 'site', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(ROOT, 'site', 'app.js'), 'utf8');
  const english = vm.runInNewContext('(' + appJs.match(/const english = (\{[\s\S]*?\n  \});/)[1] + ')');
  const dynamic = appJs.slice(appJs.indexOf('const chinese ='), appJs.indexOf('const english ='));
  const keys = new Set([...html.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1]));
  for (const match of dynamic.matchAll(/'([\w.]+)':/g)) keys.add(match[1]);
  assert.deepEqual(Object.keys(english).sort(), [...keys].sort());
  for (const key of keys) assert.ok(english[key].trim(), key);
});

test('bilingual README files cross-link cleanly', () => {
  const zhReadme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const enReadme = fs.readFileSync(path.join(ROOT, 'README.en.md'), 'utf8');

  assert.match(zhReadme, /href="README\.en\.md"/);
  assert.match(enReadme, /href="README\.md"/);
  const pages = 'https://xjzc-mt.github.io/agent-switcher/';
  const sourceLink = 'href="site/"';
  if (zhReadme.includes(sourceLink)) {
    assert.ok(enReadme.includes(sourceLink) && fs.existsSync(path.join(ROOT, 'site/index.html')));
  } else {
    assert.ok(zhReadme.includes('href="' + pages + '"') && enReadme.includes('href="' + pages + '?lang=en"'));
  }
});

test('the download chooser exposes only uploaded installers for the stable tag and architecture', async () => {
  const html = fs.readFileSync(path.join(ROOT, 'site/index.html'), 'utf8');
  const script = fs.readFileSync(path.join(ROOT, 'site/app.js'), 'utf8');
  const releases = 'https://github.com/xjzc-mt/agent-switcher/releases';
  const version = '1.2.3', tag = 'v' + version;
  const names = {
    macArmDownload: `AgentSwitcher-${version}-arm64.dmg`,
    macIntelDownload: `AgentSwitcher-${version}-x64.dmg`,
    windowsDownload: `AgentSwitcher-Setup-${version}-x64.exe`,
  };
  const asset = name => ({ name, size: 123, state: 'uploaded', browser_download_url: releases + '/download/' + tag + '/' + name });
  const all = Object.values(names).map(asset);
  const stable = { draft: false, prerelease: false, tag_name: tag, html_url: releases + '/tag/' + tag, assets: all };
  const partial = [all[0], { ...all[1], browser_download_url: all[0].browser_download_url }, { ...all[2], state: 'starter' }];
  const cases = [
    [null, []], [{ ...stable, prerelease: true }, []],
    [{ ...stable, tag_name: 'v1.0.1', html_url: releases + '/tag/v1.0.1' }, []],
    [{ ...stable, assets: partial }, ['macArmDownload']], [stable, Object.keys(names)],
  ];
  assert.match(html, /href="#install">\s*<span data-i18n="hero.download">/);
  assert.ok(html.includes(`href="${releases}"`));
  for (const [release, available] of cases) {
    const elements = new Map();
    for (const [, attrs] of html.matchAll(/<(?:a|span|p)\b([^>]*\bid="[^"]+"[^>]*)>/g)) {
      elements.set(attrs.match(/\bid="([^"]+)"/)[1], { href: attrs.match(/\bhref="([^"]+)"/)?.[1], hidden: /\bhidden\b/.test(attrs), dataset: {} });
    }
    const document = { documentElement: {}, querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, getElementById: id => elements.get(id) };
    vm.runInNewContext(script, { window: { location: { search: '?lang=en' } }, document, URLSearchParams,
      fetch: async () => ({ ok: !!release, json: async () => release }) });
    await new Promise(resolve => setImmediate(resolve));
    for (const [id, name] of Object.entries(names)) {
      assert.equal(elements.get(id).hidden, !available.includes(id));
      assert.equal(elements.get(id).href, available.includes(id) ? asset(name).browser_download_url : undefined);
    }
    assert.equal(elements.get('installVersionPill').hidden, !available.length);
    assert.equal(elements.get('heroReleaseTag').hidden, !available.length);
    if (available.length) assert.equal(elements.get('installVersionPill').textContent, tag);
  }
});

test('install.sh checks syntax and verifies signed DMG installation and atomic replacement', () => {
  const { spawnSync, execFileSync } = require('node:child_process');
  const { createHash } = require('node:crypto');
  const scriptPath = path.join(ROOT, 'site/install.sh');
  const syntax = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  if (process.platform !== 'darwin') return;

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ags-install-sh-')));
  try {
    const installDir = path.join(root, 'Applications');
    const serveDir = path.join(root, 'releases');
    const makeRelease = (version, corrupt = false) => {
      const tag = `v${version}`, dmgName = `AgentSwitcher-${version}-arm64.dmg`;
      const dlDir = path.join(serveDir, 'download', tag);
      fs.mkdirSync(dlDir, { recursive: true });
      const dmgFile = path.join(dlDir, dmgName);
      if (!fs.existsSync(dmgFile)) {
        const src = path.join(root, `src-${version}`), app = path.join(src, 'AgentSwitcher.app');
        fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
        fs.writeFileSync(path.join(app, 'Contents/Info.plist'),
          `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.agent-switcher.test</string><key>CFBundleExecutable</key><string>AgentSwitcher</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
        fs.writeFileSync(path.join(app, 'Contents/MacOS/AgentSwitcher'), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
        execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'ignore' });
        execFileSync('/usr/bin/hdiutil', ['create', '-ov', '-quiet', '-fs', 'HFS+', '-srcfolder', src, dmgFile]);
      }
      const bytes = fs.readFileSync(dmgFile);
      const sha256 = corrupt ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex');
      const manifestFile = `${dmgFile}.signed.json`;
      fs.writeFileSync(manifestFile, JSON.stringify({ version, name: dmgName, size: bytes.length, sha256, signature: 'A'.repeat(88) }));
      const base = `file://${serveDir}`;
      const releaseJson = path.join(root, `latest-${version}-${corrupt}.json`);
      fs.writeFileSync(releaseJson, JSON.stringify({
        draft: false, prerelease: false, tag_name: tag, html_url: `${base}/tag/${tag}`,
        assets: [
          { name: dmgName, size: bytes.length, state: 'uploaded', digest: `sha256:${sha256}`, browser_download_url: `${base}/download/${tag}/${dmgName}` },
          { name: `${dmgName}.signed.json`, size: fs.statSync(manifestFile).size, state: 'uploaded', browser_download_url: `${base}/download/${tag}/${dmgName}.signed.json` },
        ],
      }));
      return { base, api: `file://${releaseJson}` };
    };

    const first = makeRelease('0.1.0');
    const run1 = spawnSync('bash', [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, AGS_ARCH: 'arm64', AGS_RELEASE_API: first.api, AGS_RELEASES_URL: first.base, AGS_INSTALL_DIR: installDir, AGS_NO_OPEN: '1' },
    });
    assert.equal(run1.status, 0, run1.stderr);
    const bin = path.join(installDir, 'AgentSwitcher.app/Contents/MacOS/AgentSwitcher');
    assert.match(fs.readFileSync(bin, 'utf8'), /0\.1\.0/);

    const bad = makeRelease('0.1.1', true);
    const runBad = spawnSync('bash', [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, AGS_ARCH: 'arm64', AGS_RELEASE_API: bad.api, AGS_RELEASES_URL: bad.base, AGS_INSTALL_DIR: installDir, AGS_NO_OPEN: '1' },
    });
    assert.notEqual(runBad.status, 0);
    assert.match(fs.readFileSync(bin, 'utf8'), /0\.1\.0/);

    const second = makeRelease('0.1.1');
    const run2 = spawnSync('bash', [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, AGS_ARCH: 'arm64', AGS_RELEASE_API: second.api, AGS_RELEASES_URL: second.base, AGS_INSTALL_DIR: installDir, AGS_NO_OPEN: '1' },
    });
    assert.equal(run2.status, 0, run2.stderr);
    assert.match(fs.readFileSync(bin, 'utf8'), /0\.1\.1/);
    assert.deepEqual(fs.readdirSync(installDir), ['AgentSwitcher.app']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
