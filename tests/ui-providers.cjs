const suite = require('./ui-support.cjs');
const assert = require('node:assert/strict');

module.exports = suite(
  { width: 880, height: 700 },
  async ({ window: w, run, load, until, pause, capture }) => {
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
    await run(`providerTestApi.native();providerTestApi.cli('missing');loadStatus()`);
    assert.deepEqual(await run(`[$('btnRefresh').hidden,document.querySelector('.current-plan').textContent,document.querySelector('.credential-card .plan-tier').textContent]`),[true,'Ultra','Pro']);
    await run(`document.querySelector('[data-action=openAntigravityInstall]').click(); document.querySelector('.btn-switch').click()`);
    await until("!switchingAccount && agentsData[1].active==='Google B'");
    await run("openSaveModal('agy')");
    assert.deepEqual(await run("[activeDialog.tab,$('btnModalLaunch').textContent,$('btnCopyLoginLink').hidden,$('addTab-backup').hidden,$('addTab-session').hidden]"),['local','打开 Antigravity 登录',true,false,false]);
    await run("handleLaunchLogin('agy')");
    await run("providerTestApi.desktopLogin('desktop@example.test')");
    await pause(2500);await until("$('modalAccountEmail').textContent.includes('desktop@example.test')");
    await run("$('modalProfileInput').value='Desktop';confirmSaveProfile()");
    assert.ok(await run("agentsData[1].profiles.some(p=>p.name==='Desktop' && p.meta.email==='desktop@example.test')"));
    assert.ok(await run("testApi.calls().some(c=>c.method==='open-agy-install') && !testApi.calls().some(c=>c.method==='refresh' && c.id==='agy')"));
    await run("providerTestApi.cli('outdated','1.5.8');document.querySelector('[data-action=recheckAntigravityCli]').click()");
    await until("document.querySelector('.cli-notice')?.textContent.includes('本机 agy CLI 版本过旧（当前 v1.5.8），请运行 agy update 更新后查看额度')");
    assert.equal(await run("document.querySelector('[data-action=openAntigravityInstall]')"),null);
    await run("providerTestApi.native();providerTestApi.cli('ready','1.5.9');document.querySelector('[data-action=recheckAntigravityCli]').click()");
    await until("!$('btnRefresh').hidden && !!document.querySelector('.current-quota')");
    assert.equal(await run("testApi.calls().filter(c=>c.method==='recheck-agy').length"),2);
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
