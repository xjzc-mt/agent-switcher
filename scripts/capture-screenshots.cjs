// Capture the real renderer with fake accounts, without starting the production main process.
require('../tests/ui-support.cjs'); // Isolated Electron userData; cleaned up when the process exits.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const output = path.join(__dirname, '../docs/images');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const screenshots = [];

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 840, height: 700, show: false, titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, '../tests/fixture-preload.cjs'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  const errors = [];
  window.webContents.on('console-message', event => {
    if (event.level === 'error') errors.push(event.message);
  });
  window.webContents.session.webRequest.onBeforeRequest((request, callback) => {
    callback({ cancel: /^https?:|^wss?:/.test(request.url) });
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const run = source => window.webContents.executeJavaScript(source);
  const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const until = async expression => {
    for (let i = 0; i < 100; i++) {
      if (await run(expression)) return;
      await pause(20);
    }
    throw new Error(`Screenshot state did not settle: ${expression}`);
  };
  const reset = async () => {
    await window.loadFile(path.join(__dirname, '../renderer/index.html'));
    await until('agentsData.length === 3 && !loading');
    await run(`localStorage.clear(); applySidebar(); window.providerTestApi.native()`);
    await run(`(async () => {
      const names = ['我的日常账号', '同事小林 · 长任务', '小组代码审查', '朋友小周 · 备用'];
      for (const [index, profile] of agentsData[0].profiles.entries()) {
        await window.api.renameProfile('codex', profile.name, names[index]);
      }
      await loadStatus();
    })()`);
    await run(`clearTimeout(quotaRefreshTimer); accountLayout = 'cards'; selectTab('codex')`);
  };
  const capture = async (name, visibleText = []) => {
    await run(`document.activeElement?.blur(); document.getElementById('toastBox').replaceChildren()`);
    await pause(200); // Let the application's dialog transitions finish before capture.
    const text = await run('document.body.innerText');
    for (const expected of visibleText) assert.ok(text.includes(expected), `${name}: ${expected}`);
    assert.equal(await run('document.documentElement.scrollWidth > innerWidth'), false, name);
    const outside = await run(`[...document.querySelectorAll('dialog[open]')].some(dialog => {
      const r = dialog.getBoundingClientRect();
      return r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight;
    })`);
    assert.equal(outside, false, `${name}: dialog is outside the viewport`);
    fs.writeFileSync(path.join(output, name), (await window.webContents.capturePage()).toPNG());
    screenshots.push(name);
  };
  try {
    fs.mkdirSync(output, { recursive: true });
    await reset();
    // Only fixture data changes: the application's layout, text and styles are untouched.
    await run(`{
      const agent = agentsData[0], base = structuredClone(agent.profiles[0]);
      const now = Date.now(), seconds = Math.floor(now / 1000);
      const make = (name, index, plan, short, week) => {
        const profile = structuredClone(base);
        profile.name = name;
        profile.isActive = index === 0;
        profile.refreshAt = Infinity;
        profile.meta.email = 'demo-' + (index + 1) + '@example.test';
        const status = profile.meta.snapshot;
        status.account = profile.meta.email;
        status.plan = plan;
        status.quota = {};
        if (short !== null) status.quota.primaryWindow = {
          usedPercent: 100 - short, windowMins: 300, resetsAt: seconds + 7200 + index * 600,
        };
        status.quota.secondaryWindow = {
          usedPercent: 100 - week, windowMins: 10080, resetsAt: seconds + 345600 + index * 3600,
        };
        if (index === 0) status.quota.credits = { balance: '12.5' };
        return profile;
      };
      agent.profiles = [
        make('我的日常账号', 0, 'plus', 82, 65),
        make('同事小林 · 长任务', 1, 'pro', null, 92),
        make('小组代码审查', 2, 'prolite', null, 76),
        make('朋友小周 · 备用', 3, 'plus', 96, 88),
        make('同事小陈 · 项目', 4, 'plus', 68, 54),
        make('我的文档账号', 5, 'plus', 24, 43),
      ];
      agent.active = agent.profiles[0].name;
      agent.status = agent.profiles[0].meta.snapshot;
      agent.refreshAt = Infinity;
      $('badge-count-codex').textContent = agent.profiles.length;
      syncSidebarLabels(); renderWorkbench();
    }`);
    await capture('01-codex-cards.png', ['我的日常账号', '同事小林 · 长任务', '朋友小周 · 备用']);
    await run(`accountLayout = 'rows'; renderWorkbench()`);
    await capture('02-codex-rows.png', ['小组代码审查', '同事小陈 · 项目']);

    await run(`{
      const agent = agentsData.find(a => a.id === 'agy');
      const base = structuredClone(agent.profiles[1]);
      agent.profiles.push(...['小组模型实验', '朋友小周 · 备用'].map((name, i) => {
        const profile = structuredClone(base);
        profile.name = name; profile.meta.email = 'google-demo-' + (i + 1) + '@example.test';
        profile.meta.snapshot.account = profile.meta.email;
        profile.meta.snapshot.quota.buckets.forEach((bucket, j) => bucket.windows.forEach(w => {
          w.usedPercent = 20 + i * 25 + j * 10;
          w.resetsAt = Math.floor(Date.now() / 1000) + (w.windowMins === 300 ? 7200 : 345600);
        }));
        return profile;
      }));
      agent.profiles[0].name = '我的灵感账号'; agent.active = agent.profiles[0].name;
      agent.profiles[1].name = '同事小林 · 项目';
      $('badge-count-agy').textContent = agent.profiles.length;
      syncSidebarLabels(); accountLayout = 'cards'; selectTab('agy');
    }`);
    await capture('03-antigravity.png', ['我的灵感账号', '同事小林 · 项目', '小组模型实验']);

    await reset();
    await run(`openSaveModal('codex'); handleLaunchLogin('codex', 'private')`);
    await run(`window.loginTestApi.complete('colleague-demo@example.test'); handleModalDetect()`);
    await until('localAccountReady');
    await click('#keepAdding');
    await run(`$('modalProfileInput').value = '同事授权备用'; $('modalProfileInput').dispatchEvent(new Event('input', { bubbles: true }))`);
    assert.equal(await run(`$('modalProfileInput').value`), '同事授权备用');
    await capture('04-add-account.png', ['colleague-demo@example.test', '保存并继续']);

    await reset();
    await run(`openSaveModal('codex'); selectAddTab('session'); window.testApi.setImportMode('batch')`);
    await click('#btnChooseSessionFile');
    await until(`document.querySelectorAll('.credential-import-row').length === 4`);
    await run(`addPreview.items.find(item => item.state === 'duplicate').duplicate = {
      key: 'codex/我的日常账号', profile: '我的日常账号', source: 'pool'
    }; showAddPreview(addPreview);
    [...document.querySelectorAll('[name="import-name"]')].forEach((input, index) => {
      input.value = ['同事小林', '朋友小周'][index]; input.dispatchEvent(new Event('input', { bubbles: true }));
    })`);
    assert.equal(await run(`$('btnConfirmSave').disabled`), false);
    await capture('05-import-preview.png', ['2 个待导入', '1 个重复', '我的日常账号']);

    await reset();
    await run('startSelection(); selectAllExport(); void exportSelected()');
    await until(`!!document.querySelector('dialog[open] [name="password"]')`);
    await run(`document.querySelector('[name="password"]').value = 'demo-password';
      document.querySelector('[name="repeat"]').value = 'demo-password'`);
    assert.equal(await run('exportSelection.size'), 4);
    await capture('06-encrypted-backup.png', ['加密导出', '朋友小周 · 备用', '小组代码审查']);

    await reset();
    await run(`openAccountDetails('codex', '我的日常账号')`);
    await click('[data-action="handleDeleteProfile"]');
    await until(`!!document.querySelector('dialog[data-account-details]').deletePreview`);
    assert.equal(await run(`document.querySelector('[data-delete-logout]').checked`), false);
    await capture('07-remove-confirmation.png', ['从 AGS 移除「我的日常账号」', '客户端登录、历史记录和项目文件将保留']);

    await reset();
    const version = JSON.stringify(require('../package.json').version);
    await run(`window.appUpdateTestApi.setState({ currentVersion: ${version} })`);
    await run(`selectTab('settings')`);
    await until(`document.querySelector('#appUpdateVersion').textContent === ${version}`);
    await run(`document.querySelector('.app-update-mark').decode()`);
    assert.ok(await run(`document.querySelector('.app-update-mark').naturalWidth > 0`), 'Settings brand mark must load');
    await capture('08-settings.png', ['尚未检查新版', '无痕登录入口']);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ output, screenshots, fixtureOnly: true }, null, 2));
    window.destroy();
    app.quit();
  } catch (error) {
    console.error(error);
    window.destroy();
    app.exit(1);
  }
});
