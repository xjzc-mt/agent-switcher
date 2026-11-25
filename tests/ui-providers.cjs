const suite = require('./ui-support.cjs');
const assert = require('node:assert/strict');

module.exports = suite(
  { width: 880, height: 700 },
  async ({ window: w, run, load, pause, capture }) => {
    await load();
    await run(`window.providerTestApi.setup();loadStatus();`);
    assert.deepEqual(await run(`[...document.querySelectorAll('.sidebar-menu .nav-item[data-action]')].map(e=>e.dataset.agent)`),['codex','agy']);
    await run(`document.querySelector('#nav-claude').click();selectTab('claude');openSaveModal('claude')`);
    assert.equal(await run(`currentTab`),'codex');
    assert.equal(await run(`document.querySelector('#saveModalOverlay').open`),false);
    for(const collapsed of [false,true]) {
      await run(`localStorage.setItem('sidebarCollapsed','${collapsed}');applySidebar()`);
      const point=await run(`(()=>{const r=document.querySelector('#nav-claude').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
      w.webContents.sendInputEvent({type:'mouseMove',...point});await pause(650);
      assert.match(await run(`document.querySelector('[role=tooltip]')?.textContent||''`),/Claude Code · 暂不支持/);
      await capture(`unsupported-provider-${collapsed?'collapsed':'expanded'}.png`);
      await run(`document.querySelector('#nav-claude').focus()`);
      w.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
      w.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});await pause(50);
      assert.equal(await run(`currentTab`),'codex');
      w.webContents.sendInputEvent({type:'mouseMove',x:700,y:600});
    }
    await run(`localStorage.setItem('sidebarCollapsed','false');applySidebar();
      agentsData.find(a=>a.id==='codex').management={canSaveCurrent:false,isolatedLogin:true,quota:true};openSaveModal('codex')`);
    assert.deepEqual(await run(`[activeDialog.tab,$('btnConfirmSave').hidden,$('btnCopyLoginLink').hidden]`),['local',false,false]);
    await run(`loadStatus()`);
    assert.equal(await run(`document.querySelector('#modalPlatformSelect option[value=claude]')`),null);
    assert.deepEqual(await run(`[...document.querySelector('#modalPlatformSelect').options].map(e=>e.value)`),['codex','agy']);
    await run(`closeSaveModal()`);
    await run(`selectTab('agy')`);
    w.setSize(760,700);
    for(const layout of ['cards','rows']) {
      await run(`accountLayout='${layout}';renderWorkbench()`);
      assert.equal(await run(`document.querySelectorAll('.current-quota,.card-resources,.credit-corner,.reset-ticket,.row-column-head').length`),0);
      assert.equal(await run(`document.querySelectorAll('[data-action="handleSwitchProfile"],[data-action="handleRestartClient"]').length`),0);
      assert.equal(await run(`document.querySelectorAll('.credential-card').length`),1);
      assert.equal(await run(`[...document.querySelectorAll('.account-card,.provider-session-card,.account-list')].some(e=>e.clientWidth&&e.scrollWidth>e.clientWidth+1)`),false);
    }
    assert.equal(await run(`document.querySelectorAll('.provider-notice').length`),1);
    await run(`openAccountDetails('agy',agentsData.find(a=>a.id==='agy').profiles[0].name)`);
    assert.doesNotMatch(await run(`document.querySelector('[data-account-details]').textContent`),/Credits|未取得|上次更新|刷新额度/);
    assert.deepEqual(await run(`[...document.querySelectorAll('[data-account-details] .account-actions button')].map(b=>b.textContent)`),['删除账号','导出账号']);
    await run(`document.querySelector('[data-account-details]').dismissAccountDialog(false)`);
    await run(`selectTab('agy');openSaveModal('agy')`);await pause(100);
    assert.equal(await run(`activeDialog.tab`),'session');
    await run(`selectAddTab('local')`);await pause(100);
    assert.equal(await run(`document.querySelector('#modalProfileInput').hidden`),true);
    assert.equal(await run(`document.querySelector('#modalProfileInput').required`),false);
    assert.equal(await run(`document.querySelector('#btnConfirmSave').hidden`),true);
    await run(`closeSaveModal();`);
    await run(`window.providerTestApi.native();loadStatus()`);await pause(100);
    await run(`selectTab('agy');renderWorkbench()`);
    assert.equal(await run(`document.querySelector('.current-plan').textContent`),'Ultra');
    const gradients=await run(`[...document.querySelectorAll('linearGradient')].map(g=>g.id)`);
    assert.ok(gradients.length>=2 && new Set(gradients).size===gradients.length);
    assert.equal(await run(`document.querySelector('.current-plan').matches('[title],[data-tooltip]')`),false);
    assert.equal(await run(`document.querySelector('.account-plan-group').dataset.family`),'google ai pro');
    assert.doesNotMatch(await run(`document.querySelector('#workspaceContent').textContent`),/Credits|周期未知/);
    // Native quota layout, model groups and narrow cards are exercised together below.
    await require('./ui-antigravity.cjs')(w,run);
    await run(`openAccountDetails('agy','Google B')`);await pause(100);
    assert.match(await run(`document.querySelector('[data-account-details]').textContent`),/Google AI Pro/);
    assert.match(await run(`document.querySelector('[data-account-details]').textContent`),/Claude \/ GPT · 7d/);
    assert.doesNotMatch(await run(`document.querySelector('[data-account-details]').textContent`),/Credits/);
    await run(`refreshSelected('agy','Google B',true)`);
    assert.equal(await run(`agentsData.find(a=>a.id==='agy').active`),'Google A');
    await run(`document.querySelector('[data-account-details]').dismissAccountDialog(false);openSaveModal('agy')`);
    assert.equal(await run(`document.querySelector('#btnCopyLoginLink').hidden`),false);
    await run(`handleLaunchLogin('agy','private')`);
    assert.equal(await run(`activeDialog.login.isolated`),true);
    await run(`window.loginTestApi.complete('added-google@example.test');handleModalDetect()`);
    assert.equal(await run(`activeDialog.login.ready`),true);
    await run(`document.querySelector('#modalProfileInput').value='Google C';confirmSaveProfile()`);
    assert.equal(await run(`agentsData.find(a=>a.id==='agy').active`),'Google A');
    assert.equal(await run(`agentsData.find(a=>a.id==='agy').profiles.some(p=>p.name==='Google C')`),true);
    await run(`handleSwitchProfile('agy','Google B')`);
    assert.equal(await run(`agentsData.find(a=>a.id==='agy').active`),'Google B');
    await run(`handleSwitchProfile('agy','Google A')`);
    assert.equal(await run(`agentsData.find(a=>a.id==='agy').active`),'Google A');
    await run(`{ const a=agentsData.find(a=>a.id==='agy'); a.status={available:false,state:'error',extra:'上次 Antigravity 切换中断，请从账号列表重新切换以核对并恢复登录'};
      a.profiles.forEach(p=>p.isActive=false); renderWorkbench(); }`);
    assert.match(await run(`document.querySelector('.unassigned-tip').textContent`), /切换中断/);
  },
);
