const outputPath = require('./ui-support.cjs');
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
  const w=new BrowserWindow({width:880,height:740,show:false,webPreferences:{preload:path.join(__dirname,'fixture-preload.cjs'),contextIsolation:true}});
  const run=s=>w.webContents.executeJavaScript(s);
  const click=selector=>run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const until=async expression=>{for(let i=0;i<80;i++){if(await run(expression))return;await pause(20);}throw new Error('Timed out: '+expression);};
  const capture=async name=>{await pause(180);fs.writeFileSync(outputPath(`${name}.png`),(await w.webContents.capturePage()).toPNG());};
  try {
    await w.loadFile(path.join(__dirname,'../renderer/index.html'));await pause(200);
    await run(`localStorage.clear();applySidebar();window.accountTestApi.proTiers();loadStatus()`);
    for(const layout of ['cards','rows']) {
      await run(`accountLayout='${layout}';renderWorkbench()`);
      assert.equal(await run(`document.querySelector('.current-plan').textContent`),'Pro·500');
      assert.equal(await run(`document.querySelectorAll('.account-plan-group').length`),1);
      const plans=await run(`Array.from(document.querySelectorAll('.account-card .plan-tier')).map(e=>({label:e.textContent,color:getComputedStyle(e).color}))`);
      assert.deepEqual(plans.map(p=>p.label),['Pro·500','Pro·100','Pro·200']);
      assert.equal(new Set(plans.map(p=>p.color)).size,3);
      for(const p of plans){const rgb=p.color.match(/\d+/g).slice(0,3).map(n=>Number(n)/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4);assert.ok(1.05/(rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722+.05)>=4.5,p.color);}
      assert.equal(await run(`[...document.querySelectorAll('.account-card,.account-title-row,.account-secondary')].some(e=>e.clientWidth&&e.scrollWidth>e.clientWidth+1)`),false);
      await capture(`pro-tiers-${layout}`);
    }
    await run(`accountLayout='cards';renderWorkbench();openAccountDetails('codex','工作账号');window.details=document.querySelector('dialog[data-account-details]');window.confirm=()=>{throw new Error('Unexpected second confirmation modal')};void 0`);
    assert.equal(await run(`!!document.querySelector('.detail-update-row [data-refresh-account]')`),true);
    await click('[data-action="handleExportProfile"]');
    await until(`!!document.querySelector('[name="password"]')`);
    await click('[data-cancel]');
    assert.equal(await run(`window.testApi.calls().filter(c=>c.method==='export').length`),0);
    await click('[data-action="handleExportProfile"]');
    await until(`!!document.querySelector('[name="password"]')`);
    await run(`document.querySelector('[name="password"]').value='test-password';document.querySelector('[name="repeat"]').value='test-password';document.querySelector('[name="password"]').form.requestSubmit()`);
    await until(`window.testApi.calls().some(c=>c.method==='export')`);
    assert.deepEqual(await run(`window.testApi.calls().find(c=>c.method==='export').items`),[{agent:'codex',profile:'工作账号'}]);
    assert.equal(await run(`window.details.open`),true);
    await run(`window.accountTestApi.failDelete()`);await click('[data-action="handleDeleteProfile"]');await click('[data-action="confirmDeleteProfile"]');
    await until(`!!document.querySelector('.detail-delete-error')`);
    assert.equal(await run(`document.querySelector('.detail-delete-error').textContent`),'模拟删除失败');
    assert.equal(await run(`agentsData[0].profiles.length`),4);
    await run(`window.accountTestApi.blockDelete()`);await click('[data-action="confirmDeleteProfile"]');
    await until(`window.details.hasAttribute('data-deleting')`);
    await run(`confirmDeleteProfile('codex','工作账号',document.querySelector('[data-action="confirmDeleteProfile"]'));loadStatus()`);
    assert.equal(await run(`window.testApi.calls().filter(c=>c.method==='delete').length`),2);
    assert.equal(await run(`[...window.details.querySelectorAll('button')].every(e=>e.disabled)`),true);
    await run(`window.accountTestApi.releaseDelete()`);
    await until(`!window.details.isConnected&&agentsData[0].profiles.length===3`);
    assert.equal(await run(`agentsData[0].active`),'个人主力');
    assert.equal(await run(`window.testApi.calls().filter(c=>['switch','login'].includes(c.method)).length`),0);
    await run(`openAccountDetails('codex','个人主力')`);await click('[data-action="handleDeleteProfile"]');await click('[data-action="confirmDeleteProfile"]');
    await until(`!document.querySelector('dialog[data-account-details]')&&agentsData[0].profiles.length===2`);
    assert.equal(await run(`agentsData[0].status.available`),true,'Removing a backup keeps the client login');
    await run(`openAccountDetails('codex','')`);
    assert.equal(await run(`!!document.querySelector('[data-action="handleDeleteProfile"],[data-action="handleExportProfile"],[data-edit-account-name]')`),false);
    await run(`document.querySelector('dialog[data-account-details]').dismissAccountDialog()`);
    await run(`localStorage.clear()`);
    console.log(JSON.stringify({passed:true,proTiers:3,layouts:2,deleteConfirmInline:true,deleteFailureRetained:true,noDoubleDelete:true,currentLoginPreserved:true,singleExport:true,refreshBesideTimestamp:true}));app.exit(0);
  } catch(error){console.error(error);fs.writeFileSync(outputPath('ags-account-actions-failure.png'),(await w.webContents.capturePage()).toPNG());app.exit(1);}
});
