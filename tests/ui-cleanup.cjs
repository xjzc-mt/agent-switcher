const outputPath = require('./ui-support.cjs');
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CODEX_CLEANUP_PROMPT } = require('../dist/cleanup-prompt');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 880, height: 740, show: false,
    webPreferences: { preload: path.join(__dirname, 'fixture-preload.cjs'), contextIsolation: true } });
  const run = source => window.webContents.executeJavaScript(source);
  const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const capture = async name => { await pause(180); fs.writeFileSync(outputPath(name), (await window.webContents.capturePage()).toPNG()); };
  const until = async expression => {
    for (let i = 0; i < 80; i++) { if (await run(expression)) return; await pause(20); }
    throw new Error('Timed out: ' + expression);
  };
  const preview = async name => {
    await run(`openAccountDetails('codex',${JSON.stringify(name)})`);
    await click('[data-action="handleDeleteProfile"]');
    await until(`!!document.querySelector('dialog[data-account-details]').deletePreview`);
  };
  try {
    await window.loadFile(path.join(__dirname, '../renderer/index.html'));
    await until(`agentsData.length>0`);
    await run(`window.accountTestApi.alias('工作账号','备份<&>');loadStatus()`);
    await preview('工作账号');
    assert.deepEqual(await run(`[...document.querySelectorAll('.delete-profile-list li')].map(e=>e.textContent)`), ['工作账号', '备份<&>']);
    assert.equal(await run(`!!document.querySelector('[data-delete-logout]')`), false);
    assert.equal(await run(`window.testApi.calls().filter(c=>c.method==='delete').length`), 0);
    assert.equal(await run(`document.querySelector('.account-detail-dialog').scrollWidth>document.querySelector('.account-detail-dialog').clientWidth`), false);
    await capture('delete-scope-preview.png');
    await click('[data-action="cancelDeleteProfile"]');

    await run(`window.accountTestApi.failDeletePreview()`);
    await click('[data-action="handleDeleteProfile"]');
    await until(`!!document.querySelector('.detail-delete-error')`);
    assert.equal(await run(`document.querySelector('[data-action="confirmDeleteProfile"]').disabled`), true);
    assert.match(await run(`document.querySelector('.detail-delete-error').textContent`), /范围核对失败/);
    await click('[data-action="cancelDeleteProfile"]');
    await run(`window.accountTestApi.blockDeletePreview()`);
    await click('[data-action="handleDeleteProfile"]');
    assert.equal(await run(`document.querySelector('[data-action="confirmDeleteProfile"]').disabled`), true);
    await click('[data-action="cancelDeleteProfile"]');
    await run(`window.accountTestApi.releaseDeletePreview()`);
    await pause(30);
    assert.equal(await run(`!!document.querySelector('.detail-delete-confirm')`), false, 'Canceled preview cannot reopen the confirmation');
    await run(`document.querySelector('dialog[data-account-details]').dismissAccountDialog()`);

    await run(`window.accountTestApi.logoutUnsupported('无法确认客户端认证存储，请在官方客户端退出')`);
    await preview('个人主力');
    assert.equal(await run(`document.querySelector('[data-delete-logout]').disabled`), true);
    assert.match(await run(`document.querySelector('.detail-delete-confirm').textContent`), /官方客户端退出/);
    await click('[data-action="cancelDeleteProfile"]');
    await run(`window.accountTestApi.logoutUnsupported(undefined)`);
    await click('[data-action="handleDeleteProfile"]');
    await until(`!!document.querySelector('dialog[data-account-details]').deletePreview`);
    assert.equal(await run(`document.querySelector('[data-delete-logout]').checked`), false);
    await click('[data-delete-logout]');
    await run(`loadStatus()`);
    assert.equal(await run(`document.querySelector('[data-delete-logout]').checked`), true, 'Live status updates preserve explicit logout choice');
    assert.equal(await run(`document.activeElement.matches('[data-delete-logout]')`), true);
    assert.equal(await run(`document.querySelector('[data-action="confirmDeleteProfile"]').textContent`), '退出并移除');
    await capture('delete-current-logout.png');
    await click('[data-action="confirmDeleteProfile"]');
    await until(`!document.querySelector('dialog[data-account-details]')`);
    assert.equal(await run(`agentsData[0].status.available`), false);
    assert.equal(await run(`window.testApi.calls().find(c=>c.method==='delete').options.logout`), true);

    await run(`startSelection();exportSelection.add(profileKey('codex','工作账号'));exportSelection.add(profileKey('codex','备份<&>'));window.confirm=text=>{window.batchConfirmation=text;return true};handleDeleteSelected()`);
    await until(`!agentsData[0].profiles.some(p=>['工作账号','备份<&>'].includes(p.name))`);
    assert.match(await run(`window.batchConfirmation`), /2 份备份/);
    assert.match(await run(`window.batchConfirmation`), /备份<&>/);
    assert.equal(await run(`window.testApi.calls().filter(c=>c.method==='delete'&&c.name==='工作账号').length`), 1, 'Aliases are deleted by one approved preview');
    assert.equal(await run(`window.testApi.calls().filter(c=>c.method==='delete').at(-1).options.logout`), false);

    await run(`selectTab('settings')`);
    assert.equal(await run(`document.querySelectorAll('[data-action="copyCleanupPrompt"]').length`), 1);
    assert.doesNotMatch(await run(`document.querySelector('#workspaceContent').textContent`), /个人主力|工作账号|备份<&>/);
    const deletes = await run(`window.testApi.calls().filter(c=>c.method==='delete').length`);
    await click('[data-action="copyCleanupPrompt"]');
    await until(`window.testApi.calls().some(c=>c.method==='copy-cleanup')`);
    assert.equal(await run(`window.testApi.calls().filter(c=>c.method==='delete').length`), deletes, 'Copying cleanup instructions performs no deletion');
    const prompt = CODEX_CLEANUP_PROMPT;
    assert.match(prompt, /先只读检查/);
    assert.match(prompt, /不在 AGS 账号池里/);
    assert.match(prompt, /自身依赖目标 Codex 存储/);
    assert.doesNotMatch(prompt, /account-\d@example\.test|个人主力|工作账号|备份<&>/);
    assert.match(await run(`document.querySelector('#toastBox').textContent`), /尚未执行清理/);
    await run(`document.querySelector('#toastBox').hidePopover()`);
    await capture('cleanup-settings.png');
    console.log(JSON.stringify({ passed: true, deletionScopePreview: true, previewFailureAndCancel: true, explicitLogout: true, aliasBatchDeduplicated: true, genericCopyOnlyPrompt: true }));
    app.exit(0);
  } catch (error) {
    console.error(error);
    fs.writeFileSync(outputPath('cleanup-ui-failure.png'), (await window.webContents.capturePage()).toPNG());
    app.exit(1);
  }
});
