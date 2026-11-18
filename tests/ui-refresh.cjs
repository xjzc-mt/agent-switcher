require('./ui-support.cjs');
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const path=require('node:path');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
  const w=new BrowserWindow({width:1120,height:740,show:false,webPreferences:{preload:path.join(__dirname,'fixture-preload.cjs'),contextIsolation:true}});
  const run=s=>w.webContents.executeJavaScript(s);
  const calls=()=>run(`window.testApi.calls().filter(c=>c.method==='refresh')`);
  const idle=async()=>{for(let i=0;i<100;i++){if(await run(`refreshQueue.jobs.size===0&&!refreshing`))return;await pause(20);}throw new Error('refresh did not finish');};
  const context=selector=>run(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}))`);
  const close=()=>run(`{const d=document.querySelector('dialog[open]');d.querySelector('[data-close-dialog]').click();d.dismissAccountDialog();}`);
  try{
    await w.loadFile(path.join(process.env.AGS_UI_RENDERER_ROOT||path.join(__dirname,'../renderer'),'index.html'));await pause(150);await idle();
    await run(`Object.defineProperty(document,'hidden',{configurable:true,value:false});accountLayout='cards';renderWorkbench()`);
    const visualSnapshot=()=>run(`(()=>({
      accounts:[...document.querySelectorAll('[data-account-context]')].map(card=>({
        name:card.dataset.profile,
        quotas:[...card.querySelectorAll('.quota-cell')].map(cell=>({value:cell.querySelector('.quota-number').textContent,state:cell.dataset.valueState,color:getComputedStyle(cell.querySelector('.quota-number')).color})),
        credits:card.querySelector('.credit-badge b')?.textContent||null,
        creditClass:card.querySelector('.credit-badge,.credit-corner')?.className||null
      }))
    }))()`);
    const beforeResume=await visualSnapshot();
    const beforeResumeCalls=(await calls()).length;
    await run(`Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));window.refreshTestApi.ageSnapshots()`);
    await run(`window.refreshTestApi.blockAll();Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'))`);await pause(30);
    assert.equal((await calls()).length,beforeResumeCalls+3,'Resume starts at most three background queries');
    assert.deepEqual(await visualSnapshot(),beforeResume,'Returning to the window must preserve previous values, colors and order while the network is pending');
    assert.equal(await run(`document.querySelectorAll('.quota-cell.cached').length`),0);
    assert.match(await run(`document.querySelector('.credit-corner').dataset.tooltip`),/缓存/,'Cached data remains identifiable without graying every card');
    await run(`window.refreshTestApi.releaseAll()`);await idle();
    assert.deepEqual(await visualSnapshot(),beforeResume,'An unchanged refresh must not change the presentation');
    assert.equal(await run(`document.querySelectorAll('[data-account-context] [data-refresh-account]').length`),0);
    const initial=(await calls()).length;
    await context('[data-profile="工作账号"].account-card');
    assert.equal((await calls()).length,initial,'Opening details must not query the account');
    assert.equal(await run(`document.querySelector('dialog[data-account-details]').dataset.profile`),'工作账号');
    await run(`window.testApi.blockNextRefresh();document.querySelector('dialog [data-refresh-account]').click()`);
    await pause(30);
    assert.deepEqual((await calls()).slice(initial),[{method:'refresh',id:'codex',name:'工作账号',force:true}]);
    assert.equal(await run(`document.querySelector('dialog [data-refresh-account]').dataset.refreshState`),'running');
    assert.equal(await run(`document.querySelector('dialog [data-refresh-account]').getAttribute('aria-label')`),'刷新中…');
    assert.equal(await run(`document.querySelector('dialog [data-refresh-account]').disabled`),true);
    assert.equal(await run(`document.querySelector('dialog [data-refresh-account] svg').classList.contains('spin')`),true);
    assert.equal(await run(`document.querySelector('#refreshIcon').classList.contains('spin')`),false);
    await run(`void refreshSelected('codex','工作账号',true)`);assert.equal((await calls()).length,initial+1);
    await run(`window.testApi.releaseRefresh()`);await idle();
    assert.equal(await run(`document.querySelector('dialog [data-refresh-account]').disabled`),false);
    assert.equal(await run(`document.querySelector('dialog [data-refresh-account]').getAttribute('aria-label')`),'刷新额度');
    assert.equal(await run(`document.querySelector('dialog [data-refresh-account] svg').classList.contains('spin')`),false);
    const contextContent=await run(`document.querySelector('dialog .account-dialog-body').textContent`);
    await close();
    assert.equal(await run(`document.activeElement.closest('[data-account-context]')===null`),true);

    await run(`document.querySelector('[data-profile="工作账号"].account-card .credit-corner').click()`);
    assert.equal(await run(`document.querySelector('dialog[open]')===null`),true,'Credits corner only shows a tooltip');
    await context('[data-profile="工作账号"].account-card');
    assert.equal(await run(`document.querySelector('dialog .account-dialog-body').textContent`),contextContent);
    await run(`window.refreshTestApi.nextCredit('3.75');document.querySelector('dialog [data-action=refreshSelected]').click()`);await idle();
    assert.match(await run(`document.querySelector('dialog[open]').textContent`),/3.75/);
    assert.equal(await run(`document.querySelector('dialog[open] [data-action=refreshSelected]').disabled`),false);
    await run(`window.refreshTestApi.reuseNext();document.querySelector('dialog [data-action=refreshSelected]').click()`);await idle();
    assert.match(await run(`document.querySelector('#toastBox').textContent`),/已使用最近查询结果/);
    await close();

    await context('.active-session-card');
    assert.equal(await run(`document.querySelector('dialog[data-account-details]').dataset.profile`),'个人主力');
    const beforeCurrent=(await calls()).length;
    await run(`document.querySelector('dialog [data-refresh-account]').click()`);await idle();
    assert.deepEqual((await calls()).slice(beforeCurrent),[{method:'refresh',id:'codex',name:'个人主力',force:true}]);
    await close();
    await run(`agentsData[0].profiles.forEach(p=>p.isActive=false);renderWorkbench()`);
    await context('.active-session-card');
    assert.match(await run(`document.querySelector('dialog[open]').textContent`),/当前登录（未保存）/);
    assert.equal(await run(`document.querySelector('dialog [data-edit-account-name]')===null`),true);
    const beforeUnsaved=(await calls()).length;
    await run(`document.querySelector('dialog [data-refresh-account]').click()`);await idle();
    assert.equal((await calls()).length,beforeUnsaved+1);
    assert.equal((await calls()).at(-1).name,undefined);
    await close();

    const beforeBatch=(await calls()).length;
    await run(`window.refreshTestApi.expireAll();loadStatus()`);
    await run(`window.refreshTestApi.blockAll();void refreshAll(false)`);await pause(30);
    assert.equal((await calls()).length,beforeBatch+3,'Only three accounts may query while their results are pending');
    await context('[data-profile="备用账号"].account-card');
    assert.equal(await run(`document.querySelector('dialog [data-refresh-account]').disabled`),false);
    assert.equal(await run(`document.querySelector('dialog [data-refresh-account]').getAttribute('aria-label')`),'等待刷新…');
    await run(`document.querySelector('dialog [data-refresh-account]').click();void refreshAll(true);void refreshAll(true)`);
    assert.equal(await run(`document.querySelector('#btnRefresh').disabled`),true);
    await run(`window.refreshTestApi.releaseAll()`);await idle();
    const batch=(await calls()).slice(beforeBatch);
    assert.equal(batch.length,4);assert.equal(new Set(batch.map(c=>c.name)).size,4);assert.equal(batch[0].name,'个人主力');assert.equal(batch[3].name,'备用账号');assert.equal(batch[3].force,true);
    await close();

    const beforeFail=(await calls()).length;
    const beforeReads=await run(`window.refreshTestApi.statusReads()`);
    await run(`window.refreshTestApi.failNext();refreshAll(true)`);await idle();
    assert.equal((await calls()).length,beforeFail+4);
    assert.equal(await run(`window.refreshTestApi.statusReads()`),beforeReads+1,'A batch with a partial failure reloads the account list once');
    assert.match(await run(`document.querySelector('#toastBox').textContent`),/1 个未取得新额度/);
    assert.equal(await run(`document.querySelector('#btnRefresh').disabled`),false);
    await run(`refreshSelected('codex','个人主力',true)`);await idle();

    const beforeRepeatedBatch=(await calls()).length;
    await run(`window.refreshTestApi.expireAll();loadStatus()`);
    await run(`window.testApi.blockNextRefresh();void refreshAll(false)`);
    for(let i=0;i<100;i++){
      if((await calls()).length===beforeRepeatedBatch+4&&await run(`refreshQueue.jobs.size===1`))break;
      await pause(20);
    }
    assert.equal((await calls()).length,beforeRepeatedBatch+4);
    await run(`void refreshAll(false)`);await pause(30);
    assert.equal((await calls()).length,beforeRepeatedBatch+4,'An automatic trigger during a slow batch must not requery its completed accounts');
    await run(`void refreshAll(true);window.testApi.releaseRefresh()`);await idle();
    assert.equal((await calls()).length,beforeRepeatedBatch+4,'A manual trigger must also reuse the completed accounts in this batch');

    const beforeHidden=(await calls()).length;
    await run(`window.refreshTestApi.expireAll();loadStatus()`);
    await run(`window.refreshTestApi.blockAll();void refreshAll(false)`);await pause(30);
    await run(`Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));window.refreshTestApi.releaseAll()`);await idle();
    assert.equal((await calls()).length,beforeHidden+3,'In-flight queries finish, but the fourth account stays unqueried while hidden');
    await run(`Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'))`);await pause(30);await idle();
    assert.equal((await calls()).length,beforeHidden+4);
    await run(`accountLayout='rows';renderWorkbench()`);
    assert.equal(await run(`document.querySelectorAll('[data-account-context] [data-refresh-account]').length`),0);
    await run(`{const c=document.querySelector('[data-profile="备用账号"].account-card');c.focus();c.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'F10',shiftKey:true}));}`);
    assert.equal(await run(`document.querySelector('dialog[data-account-details]').dataset.profile`),'备用账号');
    await close();
    assert.equal(await run(`document.activeElement.dataset.profile`),'备用账号');
    await run(`startSelection()`);await context('.account-card');
    assert.equal(await run(`document.querySelector('dialog[open]')===null`),true);
    console.log(JSON.stringify({passed:true,retainsSnapshotOnResume:true,backgroundRevalidation:true,contextDetails:true,keyboardContext:true,unsavedCurrent:true,singleAccount:true,queuePriority:true,deduplication:true,partialFailure:true,detailsUpdate:true,hiddenPause:true}));app.exit(0);
  }catch(e){console.error(e);app.exit(1);}
});
