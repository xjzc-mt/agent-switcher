'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { buildSite } = require('../scripts/build-site.cjs');

const ROOT = path.resolve(__dirname, '..');

function extractI18nMaps(appSource) {
  const match = appSource.match(/const I18N = (\{[\s\S]*?\n  \});/);
  assert.ok(match, 'Expected I18N dictionary in site/app.js');
  return vm.runInNewContext(`(${match[1]})`);
}

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
  const i18n = extractI18nMaps(appJs);

  const zhKeys = Object.keys(i18n.zh).sort();
  const enKeys = Object.keys(i18n.en).sort();
  assert.deepEqual(enKeys, zhKeys, 'zh and en i18n key sets should match exactly');

  const htmlKeys = new Set([
    ...[...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/data-cap-key="([^"]+)"/g)].map((m) => m[1]),
  ]);

  for (const key of htmlKeys) {
    assert.equal(typeof i18n.zh[key], 'string', `Missing zh translation for ${key}`);
    assert.equal(typeof i18n.en[key], 'string', `Missing en translation for ${key}`);
    assert.ok(i18n.zh[key].trim().length > 0, `Empty zh translation for ${key}`);
    assert.ok(i18n.en[key].trim().length > 0, `Empty en translation for ${key}`);
  }
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
