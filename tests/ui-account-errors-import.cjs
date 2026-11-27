const suite = require('./ui-support.cjs');
const assert = require('node:assert/strict');

module.exports = suite(
  { width: 880, height: 740 },
  async ({ run, load, pause, until, capture }) => {
    await load();
    await run(`localStorage.clear();applySidebar();
      {const a=agentsData[0];a.profiles[1].meta.snapshot.state='expired';a.profiles[1].meta.snapshot.authExpired=true;
       a.profiles[1].meta.snapshot.extra='登录凭据已失效，请点击「更新凭据」重新登录';
       a.profiles[1].meta.snapshot.quota.resetCredits={availableCount:2,credits:null};
       a.profiles[2].meta.snapshot.state='error';a.profiles[2].meta.snapshot.extra='请检查网络或代理后点击刷新重试';
       a.profiles[3].meta.snapshot.state='error';delete a.profiles[3].meta.snapshot.quota;}`);
    for(const layout of ['cards','rows']) {
      await run(`accountLayout='${layout}';renderWorkbench()`);await pause(50);
      const view=await run(`(()=>{
        const card=name=>[...document.querySelectorAll('.account-card')].find(e=>e.dataset.profile===name);
        const expired=card('工作账号'),cached=card('团队账号'),missing=card('备用账号');
        return {expired:expired.querySelector('.auth-expired')?.textContent,expiredColor:getComputedStyle(expired.querySelector('.auth-expired')).color,
          expiredQuotas:expired.querySelectorAll('.quota-cell,.credit-corner,.credit-badge,.reset-ticket').length,
          action:expired.querySelector('.card-actions button').dataset.action,
          warning:!!cached.querySelector('.account-query-warning'),cachedQuotas:cached.querySelectorAll('.quota-cell[data-tone="cached"]').length,
          missing:missing.querySelector('.query-failed')?.textContent,missingColor:getComputedStyle(missing.querySelector('.query-failed')).color,
          overflow:[expired,cached,missing].some(e=>e.scrollWidth>e.clientWidth+1)};
      })()`);
      assert.equal(view.expired,'凭据失效');assert.equal(view.expiredQuotas,0);assert.equal(view.action,'openCredentialUpdate');
      assert.equal(await run(`document.querySelector('[data-profile="工作账号"] [data-action="openCredentialUpdate"]').textContent`),'更新');
      assert.equal(view.warning,true);assert.equal(view.cachedQuotas,2);assert.equal(view.missing,'查询失败');
      assert.notEqual(view.expiredColor,view.missingColor);assert.equal(view.overflow,false);
      await capture(`account-errors-${layout}.png`);
    }
    await run(`agentsData[0].profiles[3].meta.snapshot.authFailure='authentication-rejected';renderWorkbench()`);
    await run(`document.querySelector('[data-profile="备用账号"] .card-actions button').click()`);
    assert.equal(await run(`$('saveModalOverlay').open`),true);
    await run(`closeSaveModal();delete agentsData[0].profiles[3].meta.snapshot.authFailure;renderWorkbench()`);
    assert.equal(await run(`document.querySelector('[data-profile="备用账号"] .card-actions button').dataset.action`),'handleSwitchProfile');
    await run(`openAccountDetails('codex','团队账号')`);
    assert.equal(await run(`document.querySelector('[data-account-details] .detail-status-note').innerText`),'请检查网络或代理后点击刷新重试');
    assert.equal(await run(`document.querySelector('[data-account-details] [data-action="openCredentialUpdate"]')`),null);
    await run(`document.querySelector('[data-account-details]').dismissAccountDialog()`);
    await run(`document.querySelector('[data-profile="工作账号"].account-card').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}))`);
    assert.match(await run(`document.querySelector('dialog[open] .detail-status-row').textContent`),/凭据失效.*上次额度/);
    assert.equal(await run(`document.querySelector('dialog[open] .detail-status-note').innerText`),'登录凭据已失效，请点击「更新凭据」重新登录');
    assert.equal(await run(`document.querySelector('dialog[open] .detail-status[data-tooltip]')`),null);
    assert.equal(await run(`document.querySelectorAll('dialog[open] .detail-quota-list .account-detail-line').length`),2);
    await run(`document.querySelector('[data-account-details] [data-action="openCredentialUpdate"]').click()`);
    await until(`!document.querySelector('[data-account-details]') && $('saveModalOverlay').open`);
    assert.equal(await run(`document.querySelector('#addAccountTitle').textContent`),'更新凭据');
    assert.deepEqual(await run(`[...document.querySelectorAll('[data-add-tab]:not([hidden])')].map(el=>el.textContent)`),['重新登录','Session 更新']);
    assert.equal(await run(`activeDialog.tab`),'local');
    assert.equal(await run(`$('modalProfileInput').hidden`),true);
    assert.equal(await run(`$('btnConfirmSave').disabled`),true);
    assert.equal(await run(`$('addMoreOption').hidden`),true);
    assert.equal(await run(`document.activeElement.id`),'btnModalLaunch');
    assert.match(await run(`document.querySelector('#credentialUpdateTarget').textContent`),/工作账号/);
    await run(`$('addTab-local').focus();$('addTab-local').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}))`);await pause(30);
    assert.equal(await run(`activeDialog.tab`),'session');
    assert.equal(await run(`document.activeElement.id`),'addTab-session');
    await run(`selectAddTab('backup')`);
    assert.equal(await run(`activeDialog.tab`),'session');
    await run(`$('sessionCredentials').value='{"tokens":{"account_id":"wrong"}}';submitAddAccount({preventDefault(){}})`);
    assert.match(await run(`$('addAccountError').textContent`),/不属于此账号/);
    assert.equal(await run(`window.testApi.calls().filter(c=>c.method==='update').length`),0);
    await run(`$('sessionCredentials').value='{"tokens":{"account_id":"matching"}}';submitAddAccount({preventDefault(){}})`);
    assert.equal(await run(`$('sessionCredentials').value`),'');
    assert.match(await run(`$('addImportPreview').textContent`),/账号身份一致/);
    assert.equal(await run(`window.testApi.calls().filter(c=>c.method==='update').length`),0);
    const queriesBeforeUpdate=await run(`window.testApi.calls().filter(c=>c.method==='refresh').length`);
    await run(`submitAddAccount({preventDefault(){}})`);
    assert.equal(await run(`$('saveModalOverlay').open`),false);
    assert.equal(await run(`window.testApi.calls().filter(c=>c.method==='update').length`),1);
    assert.equal(await run(`window.testApi.calls().filter(c=>c.method==='refresh').length`),queriesBeforeUpdate+1);
    assert.equal(await run(`window.testApi.calls().filter(c=>c.method==='refresh').at(-1).name`),'工作账号');
    assert.match(await run(`$('toastBox').textContent`),/凭据已更新，额度已刷新/);
    assert.equal(await run(`document.querySelector('[data-profile="工作账号"].account-card [data-action="openCredentialUpdate"]')===null`),true);
    await run(`agentsData[0].profiles[1].meta.snapshot={...agentsData[0].profiles[1].meta.snapshot,state:'expired',authExpired:true};renderWorkbench();openCredentialUpdate('codex','工作账号')`);
    await run(`selectAddTab('session')`);
    await run(`chooseImportFile('credentials')`);
    assert.equal(await run(`!!activeDialog.preview`),true);
    assert.equal(await run(`window.testApi.calls().filter(c=>c.method==='preview-update').at(-1).source`),'file');
    await run(`closeSaveModal()`);
    assert.equal(await run(`window.testApi.calls().filter(c=>c.method==='update').length`),1);

    await run(`openCredentialUpdate('codex','工作账号')`);
    await run(`handleLaunchLogin('codex')`);
    await run(`handleLaunchLogin('codex','copy')`);
    const loginCalls=await run(`window.testApi.calls().filter(c=>c.method==='login').slice(-2)`);
    assert.deepEqual(loginCalls.map(c=>c.updateProfile),['工作账号','工作账号']);
    assert.equal(loginCalls[0].attempt,loginCalls[1].attempt);
    await run(`window.loginTestApi.complete('wrong@example.test');handleModalDetect()`);
    assert.equal(await run(`$('btnConfirmSave').disabled`),true);
    assert.match(await run(`$('addAccountError').textContent`),/不一致/);
    await run(`submitAddAccount({preventDefault(){}})`);
    assert.equal(await run(`window.testApi.calls().filter(c=>c.method==='update-login').length`),0);
    await run(`handleLaunchLogin('codex','copy')`);
    assert.notEqual(await run(`window.testApi.calls().filter(c=>c.method==='login').at(-1).attempt`),loginCalls[0].attempt);
    await run(`window.loginTestApi.complete('account-2@example.test');handleModalDetect()`);
    assert.equal(await run(`$('btnConfirmSave').disabled`),false);
    const beforeLoginUpdate=await run(`window.testApi.calls().filter(c=>c.method==='refresh').length`);
    await run(`submitAddAccount({preventDefault(){}})`);
    assert.equal(await run(`$('saveModalOverlay').open`),false);
    assert.equal(await run(`window.testApi.calls().filter(c=>c.method==='update-login').at(-1).name`),'工作账号');
    assert.equal(await run(`window.testApi.calls().filter(c=>c.method==='refresh').length`),beforeLoginUpdate+1);

    await run(`agentsData[0].profiles[1].meta.snapshot.state='expired';openCredentialUpdate('codex','工作账号')`);
    await run(`handleLaunchLogin('codex')`);
    await run(`selectAddTab('session')`);
    assert.equal(await run(`window.api.loginStatus('codex').then(status=>status.isolated)`),undefined);
    await run(`selectAddTab('local');handleModalDetect()`);
    assert.equal(await run(`$('btnConfirmSave').disabled`),true);
    await run(`closeSaveModal()`);
    await run(`{agentsData[0].status={...agentsData[0].status,state:'error',authExpired:true};renderWorkbench();}`);
    assert.equal(await run(`document.querySelectorAll('.active-session-card .quota-cell').length`),0);
    assert.equal(await run(`document.querySelector('.active-session-card .auth-expired').textContent`),'凭据失效');
    assert.equal(await run(`document.querySelector('.active-session-card [data-action="openCredentialUpdate"]').textContent`),'更新');
    await run(`delete agentsData[0].status.quota;renderWorkbench()`);
    await run(`openAccountDetails('codex', '个人主力')`);
    assert.equal(await run(`document.querySelector('[data-account-details] .detail-history-label')`),null);
    await run(`document.querySelector('[data-account-details]').dismissAccountDialog()`);
    const beforeDuplicates=await run(`window.testApi.calls().filter(c=>c.method==='refresh').length`);
    await run(`window.testApi.setImportMode('duplicates');openSaveModal('codex');selectAddTab('backup')`);
    await run(`chooseImportFile('backup')`);
    await run(`submitAddAccount({preventDefault(){}})`);
    assert.match(await run(`$('toastBox').querySelector('.toast-item.ok').textContent`),/新增 0 个，跳过重复 2 个/);
    assert.equal(await run(`window.testApi.calls().filter(c=>c.method==='refresh').length`),beforeDuplicates);
    await run(`localStorage.clear()`);
  },
);
