const suite = require('./ui-support.cjs');
const assert = require('node:assert/strict');
const {antigravityRenewalHint}=require('../dist/agents/antigravity');

module.exports = suite(
  { width: 1120, height: 740, additionalArguments: ['--test-manual-refresh'] },
  async ({ window, run, load, pause, until }) => {
    const calls=()=>run(`window.testApi.calls().filter(c=>c.method==='refresh')`);
    const idle=async()=>{for(let i=0;i<100;i++){if(await run(`refreshQueue.jobs.size===0&&!refreshBatches.size`))return;await pause(20);}throw new Error('refresh did not finish');};
    const context=selector=>run(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}))`);
    const close=()=>run(`{const d=document.querySelector('dialog[open]');d.querySelector('[data-close-dialog]').click();d.dismissAccountDialog();}`);

    const setIntervals=async(live,spare)=>{
      await run(`selectTab('settings')`);
      if (await run(`settings.liveRefreshInterval!=='${live}'`)) {
        await run(`document.querySelector('[name="liveRefreshInterval"][value="${live}"]').click()`);
        await until(`settings.liveRefreshInterval==='${live}'&&!document.querySelector('.setting-options input').disabled`);
      }
      if (await run(`settings.spareRefreshInterval!=='${spare}'`)) {
        await run(`document.querySelector('[name="spareRefreshInterval"][value="${spare}"]').click()`);
        await until(`settings.spareRefreshInterval==='${spare}'&&!document.querySelector('.setting-options input').disabled`);
      }
      await run(`selectTab('codex')`);
    };
    await load();await idle();
    assert.equal((await calls()).length,0,'Manual startup must not query overdue accounts');
    window.webContents.send('quota-open', 'codex');
    await pause(1100);
    assert.equal((await calls()).length,0,'Visible manual mode must not start overdue timers or reset checks');
    const expected = await run(`[agentsData[0].active, ...sortedProfiles(agentsData[0]).map(p=>p.name)]`);
    await run(`handleTrayCommand({action:'refresh', agent:'codex'})`);await idle();
    assert.deepEqual((await calls()).map(c=>[c.id,c.name,c.force]),expected.map(name=>['codex',name,true]));
    await run(`handleSwitchProfile('codex','工作账号')`);await idle();
    await run(`handleSwitchProfile('codex','个人主力')`);await idle();
    assert.equal((await calls()).length,expected.length,'Manual mode continues to suppress automatic checks after switching');
    const beforeManualAll=(await calls()).length;
    await run(`document.querySelector('#btnRefresh').click()`);await idle();
    assert.equal((await calls()).length-beforeManualAll,4,'Manual mode keeps the explicit full refresh available');
    await setIntervals('5m','30m');
    const beforeQueued=(await calls()).length;
    await run(`window.refreshTestApi.blockAll();window.importBatch=Promise.all(agentsData[0].profiles.map(p=>requestRefresh('codex',p.name,true,1)));void 0`);
    await until(`refreshQueue.running===3&&refreshQueue.jobs.size===4`);
    await setIntervals('1m','manual');
    await run(`window.refreshTestApi.releaseAll();window.importBatch`);await idle();
    assert.equal((await calls()).length-beforeQueued,3,'Switching spare to manual drops queued spare jobs while keeping live interval independent');
    await setIntervals('5m','30m');
    await run(`window.refreshTestApi.expireAll();loadStatus()`);
    for (const [name, period] of [['个人主力',300000], ['工作账号',1800000]]) {
      const delay = await run(`(async()=>{
        window.refreshTestApi.failNext();
        try {await refreshSelected('codex',${JSON.stringify(name)},true);} catch {}
        const target=refreshTargets(agentsData[0]).find(p=>p.profile===${JSON.stringify(name)});
        return target.deadline-Date.now();
      })()`);
      assert.ok(Math.abs(delay-period)<1000,'IPC failure must respect the account’s selected refresh period');
    }
    await run(`refreshAll(true)`);await idle();
    const reads=await run(`window.refreshTestApi.statusReads()`);
    await run(`window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('focus'))`);
    assert.equal(await run(`window.refreshTestApi.statusReads()`),reads,'Focus on a visible window leaves the scheduler alone');
    await run(`Object.defineProperty(document,'hidden',{configurable:true,value:false});accountLayout='cards';renderWorkbench()`);
    const visualSnapshot=()=>run(`(()=>({
      accounts:[...document.querySelectorAll('[data-account-context]')].map(card=>({
        name:card.dataset.profile,
        quotas:[...card.querySelectorAll('.quota-cell')].map(cell=>({value:cell.querySelector('.quota-number').textContent,state:cell.dataset.tone,color:getComputedStyle(cell.querySelector('.quota-number')).color})),
        credits:card.querySelector('.credit-badge b')?.textContent||null,
        creditClass:card.querySelector('.credit-badge,.credit-corner')?.className||null
      }))
    }))()`);
    await setIntervals('1m','5m');
    const beforeResume=await visualSnapshot();
    const beforeResumeCalls=(await calls()).length;
    await run(`window.refreshTestApi.ageSnapshots();window.refreshTestApi.blockAll()`);
    window.webContents.send('quota-open', 'codex');await until(`refreshQueue.running===3`);
    assert.equal((await calls()).length,beforeResumeCalls+3,'Resume starts at most three background queries');
    assert.deepEqual(await visualSnapshot(),beforeResume,'Returning to the window must preserve previous values, colors and order while the network is pending');
    assert.equal(await run(`document.querySelectorAll('.quota-cell[data-tone="cached"]').length`),0);
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
    const queued = await run(`[...refreshQueue.jobs.values()].find(job=>job.state==='queued').payload.profile`);
    await context(`[data-profile="${queued}"].account-card`);
    assert.equal(await run(`document.querySelector('dialog [data-refresh-account]').disabled`),false);
    assert.equal(await run(`document.querySelector('dialog [data-refresh-account]').getAttribute('aria-label')`),'等待刷新…');
    await run(`document.querySelector('dialog [data-refresh-account]').click();void refreshAll(true);void refreshAll(true)`);
    assert.equal(await run(`document.querySelector('#btnRefresh').disabled`),true);
    await run(`window.refreshTestApi.releaseAll()`);await idle();
    const batch=(await calls()).slice(beforeBatch);
    assert.equal(batch.length,4);assert.equal(new Set(batch.map(c=>c.name)).size,4);assert.equal(batch[0].name,'个人主力');assert.equal(batch[3].name,queued);assert.equal(batch[3].force,true);
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
    await run(`void Object.defineProperty(document,'hidden',{configurable:true,value:true})`);
    window.webContents.send('quota-power',true);await until('quotaPaused===true');
    await run(`window.refreshTestApi.releaseAll()`);await idle();
    assert.equal((await calls()).length,beforeHidden+3,'In-flight work finishes while locked; queued automatic work waits');
    window.webContents.send('quota-power',false);await until(`window.testApi.calls().filter(c=>c.method==='refresh').length===${beforeHidden+4}`);await idle();
    assert.equal((await calls()).length,beforeHidden+4,'Unlock picks up the one outstanding account with the window still hidden');
    const yesterday=new Date(Date.now()-86400000).toISOString();
    await run(`Object.defineProperty(document,'hidden',{configurable:true,value:true});window.providerTestApi.native(${JSON.stringify(yesterday)});loadStatus()`);
    await run(`selectTab('agy')`);await context('.active-session-card');
    const updatedLabel=()=>run(`document.querySelector('dialog .detail-update-row span').textContent`);
    const quotaRows=()=>run(`[...document.querySelectorAll('dialog .detail-quota-list .account-detail-line')].map(row=>row.textContent)`);
    const oldLabel=await updatedLabel(), oldQuotas=await quotaRows();
    assert.ok(oldQuotas.length>0);
    const beforeDeferred=(await calls()).length;
    await run(`window.refreshTestApi.deferNext(${JSON.stringify(antigravityRenewalHint)});document.querySelector('dialog [data-refresh-account]').click()`);
    await idle();
    assert.deepEqual((await calls()).slice(beforeDeferred),[{method:'refresh',id:'agy',name:'Google A',force:true}]);
    const detailNote=await run(`document.querySelector('dialog .detail-status-note').innerText`);
    assert.equal(detailNote,antigravityRenewalHint);
    assert.ok(!(await run(`document.querySelector('.active-session-card').innerText`)).includes(detailNote));
    assert.equal(await run(`document.querySelector('#toastBox').textContent`),detailNote);
    assert.equal(await updatedLabel(),oldLabel);
    assert.deepEqual(await quotaRows(),oldQuotas);
    assert.equal(await run(`document.querySelector('dialog [data-refresh-account]').getAttribute('aria-busy')`),'false');
    await run(`Object.defineProperty(document,'hidden',{configurable:true,value:false});refreshAll(false)`);await idle();
    assert.equal((await calls()).length,beforeDeferred+1,'A deferred check must not trigger another immediate query');
    await run(`document.querySelector('dialog [data-refresh-account]').click()`);await idle();
    assert.notEqual(await updatedLabel(),oldLabel);
    assert.notEqual(await run(`document.querySelector('dialog .detail-status-note')?.innerText`),antigravityRenewalHint);
    assert.match(await run(`document.querySelector('#toastBox').textContent`),/账号额度已刷新/);
    await close();

    const activeCalls={method:'refresh',id:'codex',name:'个人主力',force:false};
    const beforeCandidate=(await calls()).length;
    await run(`window.refreshTestApi.stageCurrent(0,600000);loadStatus()`);
    await run(`refreshAll(false)`);
    assert.equal((await calls()).length,beforeCandidate,'An overdue live login must not requery a recently checked candidate');
    await run(`window.refreshTestApi.unreadableCurrent();loadStatus()`);
    await run(`refreshAll(false)`);
    assert.equal((await calls()).length,beforeCandidate,'An unreadable saved credential must not inherit a due live deadline');
    await run(`window.refreshTestApi.stageCurrent(600000,0);loadStatus()`);
    await run(`selectTab('codex')`);await context('.active-session-card');
    const liveRows=await quotaRows(),liveUpdated=await updatedLabel();
    assert.ok(liveRows.length);
    const candidateNote=()=>run(`document.querySelector('dialog .detail-quota-list').textContent`);
    assert.match(await candidateNote(),/等待验证新凭据/);
    await run(`window.refreshTestApi.deferNext();window.refreshTestApi.failStatusReads(true);refreshAll(false)`);
    assert.deepEqual((await calls()).slice(beforeCandidate),[activeCalls],'A fresh live login must not delay a due candidate');
    assert.match(await candidateNote(),/暂不验证新凭据/,'The batch presents the updated verification reason');
    assert.deepEqual(await quotaRows(),liveRows,'A pending candidate result cannot replace live quota in a batch');
    assert.equal(await updatedLabel(),liveUpdated);
    await run(`window.refreshTestApi.failStatusReads(false);loadStatus()`);
    assert.match(await candidateNote(),/暂不验证新凭据/,'Candidate feedback must survive the next successful dashboard read');
    assert.deepEqual(await quotaRows(),liveRows);
    assert.equal(await updatedLabel(),liveUpdated);
    await close();
    assert.ok(await run(`!!document.querySelector('.active-session-card [data-action="openCredentialUpdate"]')`),
      'A saved candidate can be replaced through official login while the live quota is healthy');
    await run(`document.querySelector('.active-session-card [data-action="openCredentialUpdate"]').click()`);
    assert.equal(await run(`$('saveModalOverlay').open && activeDialog.updateTarget?.profile`),'个人主力');
    await run(`closeSaveModal()`);

    for(const manual of [false,true]){
      await run(`window.refreshTestApi.stageCurrent(600000,600000);loadStatus()`);
      const beforeOutage=(await calls()).length;
      await run(`window.refreshTestApi.failStatusReads(true)`);
      await run(manual?`refreshSelected('codex','个人主力',true)`:`refreshAll(false)`);
      await pause(1150);
      await run(`refreshAll(false)`);
      await idle();
      assert.deepEqual((await calls()).slice(beforeOutage),[{...activeCalls,force:manual}],
        'A failed account list reload must not repeat a successful quota request on the next timer or automatic trigger');
      await run(`refreshSelected('codex','个人主力',true)`);
      assert.deepEqual((await calls()).slice(beforeOutage+1),[{...activeCalls,force:true}],
        'A manual request remains available while local status is unavailable');
      await run(`window.refreshTestApi.stageCurrent(600000,0);window.refreshTestApi.failStatusReads(false);resumeQuotaRefresh()`);
      for(let i=0;i<100&&(await calls()).length===beforeOutage+2;i++)await pause(20);
      await idle();
      assert.deepEqual((await calls()).slice(beforeOutage+2),[activeCalls],
        'A fresh dashboard after recovery must immediately schedule a newly due candidate');
    }
    await setIntervals('manual','30m');
    await run(`for(const name of ['候选甲','候选乙','凭据失效']) window.accountTestApi.alias('工作账号',name);
      window.loginTestApi.expire('凭据失效');window.refreshTestApi.ageSnapshots();loadStatus()`);
    const front = await run(`sortedProfiles(agentsData[0]).filter(p=>p.name!=='凭据失效').slice(0,4).map(p=>p.name)`);
    const beforeOpen=(await calls()).length;
    window.webContents.send('quota-open','codex');await until(`window.testApi.calls().filter(c=>c.method==='refresh').length===${beforeOpen+4}`);await idle();
    assert.deepEqual((await calls()).slice(beforeOpen).map(c=>c.name),front,'Opening refreshes only the four leading eligible spares with the current account in manual mode');
    await run(`resumeQuotaRefresh('codex')`);await idle();
    assert.equal((await calls()).length,beforeOpen+4,'Recent checks occupy their existing Top-4 slots without refilling from further down the list');
  },
);
