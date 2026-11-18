const outputPath = require('./ui-support.cjs');
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
  const w=new BrowserWindow({width:880,height:700,show:false,webPreferences:{preload:path.join(__dirname,'fixture-preload.cjs'),contextIsolation:true}});
  w.webContents.on('console-message',(_event,...args)=>{if(args.some(value=>typeof value==='string'&&/Error/.test(value)))console.error(...args);});
  const run=s=>w.webContents.executeJavaScript(s);
  try {
    await w.loadFile(path.join(__dirname,'../renderer/index.html'));await pause(220);
    await run(`window.providerTestApi.setup();loadStatus();`);
    assert.deepEqual(await run(`[...document.querySelectorAll('.sidebar-menu .nav-item')].map(e=>e.dataset.agent)`),['codex','agy','claude']);
    await run(`document.querySelector('#nav-claude').click();selectTab('claude');openSaveModal('claude')`);
    assert.equal(await run(`currentTab`),'codex');
    assert.equal(await run(`document.querySelector('#saveModalOverlay').open`),false);
    for(const collapsed of [false,true]) {
      await run(`localStorage.setItem('sidebarCollapsed','${collapsed}');applySidebar()`);
      const point=await run(`(()=>{const r=document.querySelector('#nav-claude').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
      w.webContents.sendInputEvent({type:'mouseMove',...point});await pause(650);
      assert.match(await run(`document.querySelector('[role=tooltip]')?.textContent||''`),/功能开发中，敬请期待/);
      fs.writeFileSync(outputPath(`claude-coming-soon-${collapsed?'collapsed':'expanded'}.png`),(await w.webContents.capturePage()).toPNG());
      await run(`document.querySelector('#nav-claude').focus()`);
      w.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
      w.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});await pause(50);
      assert.equal(await run(`currentTab`),'codex');
      w.webContents.sendInputEvent({type:'mouseMove',x:700,y:600});
    }
    await run(`localStorage.setItem('sidebarCollapsed','false');applySidebar();openSaveModal('codex');loadStatus()`);
    assert.equal(await run(`document.querySelector('#modalPlatformSelect option[value=claude]').disabled`),true);
    assert.deepEqual(await run(`[...document.querySelector('#modalPlatformSelect').options].map(e=>e.value)`),['codex','agy','claude']);
    await run(`closeSaveModal()`);
    for(const id of ['agy'])for(const layout of ['cards','rows']) {
      await run(`selectTab('${id}');accountLayout='${layout}';renderWorkbench()`);
      assert.equal(await run(`document.querySelectorAll('.current-quota,.card-resources,.credit-corner,.reset-ticket,.row-column-head').length`),0);
      assert.equal(await run(`document.querySelectorAll('[data-action="handleSwitchProfile"],[data-action="handleRestartClient"]').length`),0);
      assert.equal(await run(`document.querySelectorAll('.provider-notice').length`),1);
      assert.equal(await run(`document.querySelectorAll('.credential-card').length`),1);
      assert.doesNotMatch(await run(`document.querySelector('#workspaceContent').textContent`),/Pro·200|套餐未知|周期额度|Credits|额度未提供/);
      for(const width of [760,880,1120]) {
        w.setSize(width,700);await pause(100);
        assert.equal(await run(`[...document.querySelectorAll('.account-card,.provider-session-card,.account-list')].some(e=>e.clientWidth&&e.scrollWidth>e.clientWidth+1)`),false,`${id}/${layout}/${width} overflow`);
      }
      w.setSize(880,700);await pause(140);
      fs.writeFileSync(outputPath(`${id}-${layout}.png`),(await w.webContents.capturePage()).toPNG());
      await run(`openAccountDetails('${id}',agentsData.find(a=>a.id==='${id}').profiles[0].name)`);await pause(180);
      assert.doesNotMatch(await run(`document.querySelector('[data-account-details]').textContent`),/Credits|未取得|上次更新|刷新额度/);
      assert.equal(await run(`document.querySelectorAll('[data-account-details] [data-action="handleDeleteProfile"]').length`),1);
      assert.equal(await run(`document.querySelectorAll('[data-account-details] [data-action="handleExportProfile"]').length`),1);
      await run(`document.querySelector('[data-account-details]').dismissAccountDialog(false)`);await pause(150);
    }
    await run(`selectTab('agy');openSaveModal('agy')`);await pause(100);
    assert.equal(await run(`addTab`),'session');
    await run(`selectAddTab('local')`);await pause(100);
    assert.equal(await run(`document.querySelector('#modalProfileInput').hidden`),true);
    assert.equal(await run(`document.querySelector('#modalProfileInput').required`),false);
    assert.equal(await run(`document.querySelector('#btnConfirmSave').hidden`),true);
    await run(`closeSaveModal();`);
    await run(`selectTab('codex');accountLayout='cards';renderWorkbench()`);
    assert.equal(await run(`document.querySelectorAll('.current-quota').length`),1);
    assert.equal(await run(`document.querySelectorAll('.card-resources').length`),3);
    await run(`window.providerTestApi.native();loadStatus()`);await pause(100);
    await run(`selectTab('agy');renderWorkbench()`);
    assert.equal(await run(`document.querySelector('.current-plan').textContent`),'Ultra');
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
    assert.equal(await run(`isolatedLoginRequested`),true);
    await run(`window.loginTestApi.complete('added-google@example.test');handleModalDetect()`);
    assert.equal(await run(`localAccountReady`),true);
    await run(`document.querySelector('#modalProfileInput').value='Google C';confirmSaveProfile()`);
    assert.equal(await run(`agentsData.find(a=>a.id==='agy').active`),'Google A');
    assert.equal(await run(`agentsData.find(a=>a.id==='agy').profiles.some(p=>p.name==='Google C')`),true);
    await run(`handleSwitchProfile('agy','Google B')`);
    assert.equal(await run(`agentsData.find(a=>a.id==='agy').active`),'Google B');
    await run(`handleSwitchProfile('agy','Google A')`);
    assert.equal(await run(`agentsData.find(a=>a.id==='agy').active`),'Google A');
    console.log('Provider UI: Claude coming-soon hover/keyboard/add guards; Antigravity and Codex preserved.');
    w.destroy();app.quit();
  } catch(error) { console.error(error);w.destroy();app.exit(1); }
});
