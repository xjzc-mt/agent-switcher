const suite = require('./ui-support.cjs');
const assert = require('node:assert/strict');

module.exports = suite(
  { width: 880, height: 740 },
  async ({ window, run, load, pause, until, click, capture }) => {
    const button = action => `[data-update-action="${action}"]`;
    const state = value => run(`window.appUpdateTestApi.setState(${JSON.stringify(value)})`);
    const capturePanel = async name => {
      if (process.env.AGS_UI_SCREENSHOTS !== '1') return;
      await run(`document.querySelector('#appUpdatePanel').scrollIntoView({block:'end'})`);
      await pause(100);
      await capture(name);
    };
    const markLayout = () => run(`(async () => {
      const image = document.querySelector('.app-update-mark');
      await image.decode();
      const mark = image.getBoundingClientRect();
      const title = document.querySelector('.app-update-name').getBoundingClientRect();
      const status = document.querySelector('.app-update-status').getBoundingClientRect();
      const card = document.querySelector('.app-update-card').getBoundingClientRect();
      return { size: [mark.width, mark.height], x: mark.left - card.left, y: mark.top - card.top,
        centered: Math.abs((mark.top + mark.bottom - title.top - status.bottom) / 2) < 1 };
    })()`);
    const release = { version: '1.1.0', name: 'AgentSwitcher-1.1.0-arm64.dmg', size: 125829120,
      downloadable: true, notes: '优化账号切换\n<img src=x onerror="window.updateInjected=true">', url: 'https://github.com/example/ags/releases/tag/v1.1.0' };

    await load();
    await window.webContents.insertCSS('.btn { transition: none !important; }');
    await until('agentsData.length > 0');
    assert.equal(await run(`!!document.querySelector('#appUpdatePanel')`), false);
    await run(`selectTab('settings')`);
    await until(`document.querySelector('#appUpdateVersion').textContent.includes('1.0.0')`);
    assert.equal(await run(`document.querySelectorAll('[data-update-action="ignore"], [data-update-action="copy"], [data-update-action="releases"], [data-update-action="release"]').length`), 0);
    assert.equal(await run(`document.querySelector('#autoCheckUpdates').matches('input[type="checkbox"]:not([role]):not(.setting-switch)')`), true);
    await click(button('project'));
    await until(`window.testApi.calls().some(c => c.method === 'update-project')`);
    await click(button('check'));
    await until(`document.querySelector('#appUpdateStatus').textContent === '暂未取得可用版本'`);
    assert.equal(await run(`document.querySelector('${button('download')}').disabled`), true);
    assert.equal(await run(`document.querySelector('${button('notes')}').hidden`), true);
    await capturePanel('app-updates-unavailable.png');

    await state({ status: 'available', release, message: '', ignoredVersion: release.version });
    assert.equal(await run(`document.querySelector('${button('download')}').matches('.btn-primary:enabled')`), true);
    assert.equal(await run(`document.querySelector('#appUpdateNotes img') !== null || window.updateInjected === true`), false);
    assert.equal(await run(`document.querySelector('#appUpdateNotes').hidden && document.querySelector('${button('notes')}').getAttribute('aria-expanded') === 'false'`), true);
    await state({ status: 'error', errorStage: 'check', message: '检查新版失败，请稍后重试' });
    assert.equal(await run(`!document.querySelector('${button('check')}').hidden && !document.querySelector('${button('check')}').disabled`), true);
    assert.equal(await run(`document.querySelector('${button('download')}').textContent`), '下载安装包');
    await state({ status: 'error', errorStage: 'download', message: '下载失败，请重试' });
    assert.equal(await run(`document.querySelector('${button('download')}').textContent`), '重新下载');
    assert.equal(await run(`document.querySelector('${button('check')}').hidden`), true);
    await run(`window.appUpdateTestApi.setState({ status: 'available', errorStage: undefined, message: '' })`);
    const collapsedMark = await markLayout();
    assert.deepEqual(collapsedMark.size, [28, 28]);
    assert.ok(collapsedMark.centered, 'Brand mark centers on the name and status together');
    await click(button('notes'));
    assert.deepEqual(await markLayout(), collapsedMark, 'Expanding release notes keeps the mark in place');
    await capturePanel('app-updates-expanded.png');
    await run(`document.querySelector('${button('notes')}').focus()`);
    await state({ status: 'checking', progress: 0 });
    await run('loadStatus()');
    assert.equal(await run(`!document.querySelector('#appUpdateNotes').hidden && document.activeElement.matches('${button('notes')}')`), true, 'Same-version updates preserve expanded notes and focus');
    await state({ status: 'available', release: { ...release, version: '1.2.0', notes: '优化账号切换流程' } });
    assert.equal(await run(`document.querySelector('#appUpdateNotes').hidden`), true, 'A different release starts collapsed');
    await click(button('notes'));
    await run(`selectTab('codex'); selectTab('settings')`);
    assert.equal(await run(`document.querySelector('#appUpdateNotes').hidden`), true, 'Re-entering settings starts collapsed');
    await click(button('notes'));
    await click(button('download'));
    await until(`!document.querySelector('${button('cancel')}').hidden`);
    await run(`window.progressNode = document.querySelector('#appUpdateProgress'); document.querySelector('${button('cancel')}').focus()`);
    await state({ progress: 37 });
    assert.equal(await run(`document.activeElement.matches('${button('cancel')}')`), true, 'Progress updates preserve focus');
    assert.equal(await run(`window.progressNode === document.querySelector('#appUpdateProgress')`), true);
    assert.equal(await run(`document.querySelectorAll('#appUpdateProgress span').length`), 0);
    await run('loadStatus()');
    assert.equal(await run(`document.activeElement.matches('${button('cancel')}')`), true, 'Account refresh leaves settings intact');
    await run(`selectTab('codex')`);
    await state({ progress: 72 });
    assert.doesNotMatch(await run(`document.querySelector('#workspaceContent').textContent`), /正在下载|检查新版|GitHub/);
    await run(`selectTab('settings')`);
    await until(`document.querySelector('#appUpdateProgress progress').value === 72`);
    assert.equal(await run(`window.appUpdateTestApi.listenerCount()`), 1);
    await capturePanel('app-updates-downloading.png');
    await click(button('cancel'));
    await until(`document.querySelector('${button('download')}').matches('.btn-primary:enabled')`);
    assert.equal(await run(`window.testApi.calls().filter(c => c.method === 'update-cancel').length`), 1);

    await click('#autoCheckUpdates');
    await until(`!document.querySelector('#autoCheckUpdates').checked && !document.querySelector('#autoCheckUpdates').disabled`);
    await click(button('notes'));
    await run(`window.savedNotes = document.querySelector('#appUpdateNotes'); window.settingsTestApi.failNext()`);
    await click('[name="showResetTimes"][value="false"]');
    await until(`document.querySelector('#toastBox').textContent.includes('模拟设置保存失败')`);
    assert.equal(await run(`document.querySelector('[name="showResetTimes"][value="true"]').checked`), true);
    assert.equal(await run(`window.savedNotes === document.querySelector('#appUpdateNotes') && !window.savedNotes.hidden`), true, 'Failed preference saves preserve the update panel');
    await run(`document.querySelector('#toastBox').hidePopover()`);
    await click('[name="showResetTimes"][value="false"]');
    await until(`window.testApi.calls().some(c => c.method === 'settings')`);
    assert.deepEqual(await run(`Object.keys(window.testApi.calls().find(c => c.method === 'settings').value).sort()`), ['liveRefreshInterval', 'openPrivateLogin', 'showResetTimes', 'spareRefreshInterval']);
    assert.equal(await run(`document.querySelector('#autoCheckUpdates').checked`), false);
    await run(`document.querySelector('[name="showResetTimes"][value="false"]').focus()`);
    window.webContents.sendInputEvent({type:'keyDown',keyCode:'Left'});
    window.webContents.sendInputEvent({type:'keyUp',keyCode:'Left'});
    await until(`document.querySelector('[name="showResetTimes"][value="true"]').checked && !document.querySelector('.setting-options input').disabled`);
    assert.equal(await run(`window.testApi.calls().filter(c=>c.method==='settings').at(-1).value.showResetTimes`), true);
    await state({ status: 'verifying', progress: 100 });
    assert.equal(await run(`document.querySelector('${button('download')}').disabled && !document.querySelector('${button('download')}').hidden && document.querySelector('${button('cancel')}').hidden`), true);
    await state({ status: 'downloaded', progress: 100 });
    assert.equal(await run(`document.querySelector('${button('download')}').hidden`), true);
    assert.equal(await run(`document.querySelector('${button('install')}').textContent`), '立即安装并重启');
    await capturePanel('app-updates-downloaded.png');
    await run(`window.appUpdateTestApi.failNext('安装包已改变，请重新下载')`);
    await click(button('install'));
    await until(`document.querySelector('#appUpdateMessage').textContent.includes('请重新下载')`);
    await state({ status: 'downloaded', installMode: 'open' });
    assert.equal(await run(`document.querySelector('${button('install')}').textContent`), '打开安装并退出');
    assert.match(await run(`document.querySelector('#appUpdateInstallHint').textContent`), /拖入「应用程序」/);
    await click(button('install'));
    await until(`window.testApi.calls().filter(c => c.method === 'update-install').length === 2`);
    await state({ status: 'available', release, message: '' });
    await run(`window.appUpdateTestApi.failNext('模拟下载连接失败')`);
    await click(button('download'));
    await until(`document.querySelector('#appUpdateMessage').textContent.includes('模拟下载连接失败')`);
    assert.equal(await run(`document.querySelector('#toastBox').matches(':popover-open')`), false);
    for (const width of [636, 1200]) {
      window.setSize(width, 740); await run(`writeLayout('sidebarCollapsed','${width===636}');applySidebar()`); await pause(40);
      assert.equal(await run(`document.documentElement.scrollWidth > innerWidth || document.querySelector('#appUpdatePanel').scrollWidth > document.querySelector('#appUpdatePanel').clientWidth`), false);
      const layout = await run(`(()=>{const panel=document.querySelector('.settings-layout').getBoundingClientRect(),area=document.querySelector('#workspaceContent').getBoundingClientRect();return {width:panel.width,center:Math.abs((panel.left-area.left)-(area.right-panel.right)),rows:[...document.querySelectorAll('.setting-row')].map(row=>{const label=row.querySelector('strong').getBoundingClientRect(),options=row.querySelector('.setting-options'),rect=options.getBoundingClientRect();return {height:row.getBoundingClientRect().height,optWidth:Math.round(rect.width),clipped:[...options.querySelectorAll('span')].some(s=>s.scrollWidth>s.clientWidth+1),aligned:Math.abs((label.top+label.bottom)/2-(rect.top+rect.bottom)/2)<1}})}})()`);
      assert.ok(layout.width <= 560 && layout.center < 2, JSON.stringify(layout));
      assert.ok(layout.rows.length === 4 && layout.rows.every(row=>row.aligned&&row.height<=50&&row.optWidth===layout.rows[0].optWidth&&!row.clipped), JSON.stringify(layout));
    }
  },
);
