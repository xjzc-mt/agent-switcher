const outputPath = require('./ui-support.cjs');
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width:1120, height:900, show:false, webPreferences:{ preload:path.join(__dirname,'fixture-preload.cjs'), contextIsolation:true, backgroundThrottling:false } });
  const errors = [];
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const run = async script => {
    try { return await window.webContents.executeJavaScript(script); }
    catch (error) { throw new Error(`Renderer script failed: ${script}`, { cause:error }); }
  };
  const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const order = () => run(`[...document.querySelectorAll('.account-plan-group[data-family]')].map(g=>g.dataset.family)`);
  const fold = family => `.account-group-toggle[data-family="${family}"]`;
  const move = (family, direction) => `[data-action="moveAccountGroup"][data-family="${family}"][data-direction="${direction}"]`;
  const setup = () => run(`{
    const agent=agentsData[0],active=structuredClone(agent.profiles[0]),now=Date.now();
    const make=(name,plan,short,week,state='ok')=>{
      const status={available:true,state,plan,fetchedAt:new Date(now).toISOString(),quota:{}};
      if(short!==null)status.quota.primaryWindow={usedPercent:100-short,windowMins:300,resetsAt:now/1000+3600};
      if(week!==null)status.quota.secondaryWindow={usedPercent:100-week,windowMins:10080,resetsAt:now/1000+345600};
      if(short===null&&week===null)delete status.quota;
      return {name,meta:{label:name,email:'account@example.test',snapshot:status}};
    };
    agent.profiles=[active,
      make('长任务备用','prolite',null,100),make('主力开发','pro',null,80),
      make('短期充足','plus',100,55),make('缺少5h','plus',null,9),make('缺少7d','plus',90,null),
      make('缓存查询','plus',85,62,'error'),make('首次查询','plus',null,null,'error'),make('失效Plus','plus',100,90,'expired')];
    $('badge-count-codex').textContent=agent.profiles.length;syncSidebarLabels();
    accountLayout='cards';selectTab('codex');
  }`);
  const geometry = () => run(`(()=>{
    const cards=[...document.querySelectorAll('.account-card')],get=name=>cards.find(c=>c.dataset.profile===name);
    return {heights:Object.fromEntries(cards.map(c=>[c.dataset.profile,c.offsetHeight])),
      missing:['缺少5h','缺少7d'].map(name=>[...get(name).querySelectorAll('.quota-cell')].map(c=>[c.querySelector('.quota-label').textContent,c.querySelector('.quota-value').textContent,c.querySelector('.quota-reset').textContent])),
      cached:get('缓存查询').querySelectorAll('.quota-cell.cached').length,
      overflow:[...document.querySelectorAll('.account-plan-group,.account-group-head,.account-card,.card-resources,.quota-cell-line')].filter(e=>e.clientWidth&&e.scrollWidth>e.clientWidth+1).map(e=>e.className)};
  })()`);
  try {
    await window.loadFile(path.join(__dirname,'../renderer/index.html'));
    await pause(300);
    await run(`localStorage.clear();applySidebar()`);
    await setup();
    assert.deepEqual(await order(), ['pro','plus']);
    assert.equal(await run(`document.querySelector('[data-family="pro"] .account-card').dataset.profile`),'主力开发');
    const initial = await geometry();
    assert.equal(initial.heights['短期充足'],103);
    for (const name of ['缺少5h','缺少7d','缓存查询']) assert.equal(initial.heights[name],initial.heights['短期充足']);
    assert.equal(initial.heights['主力开发'],84);
    for (const name of ['首次查询','失效Plus']) assert.ok(initial.heights[name] <= initial.heights['主力开发'] + 1);
    assert.deepEqual(initial.missing[0][0], ['5h','—','未提供']);
    assert.deepEqual(initial.missing[1][1], ['7d','—','未提供']);
    assert.equal(initial.cached,2);
    assert.deepEqual(initial.overflow,[]);
    assert.equal(await run(`document.querySelectorAll('.account-group-actions').length`),0);
    await pause(50);
    fs.writeFileSync(outputPath('account-groups-cards.png'),(await window.webContents.capturePage()).toPNG());
    await run(`document.querySelector('[data-profile="缺少5h"].account-card').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}))`);
    assert.match(await run(`document.querySelector('dialog[data-account-details] .detail-note').textContent`),/5h额度未提供/);
    await run(`document.querySelector('dialog[data-account-details]').dismissAccountDialog()`);

    const accountCalls = await run(`window.testApi.calls().length`);
    await click(fold('plus'));
    assert.equal(await run(`getComputedStyle(document.querySelector('[data-family="plus"] .accounts-grid')).display`),'none');
    assert.equal(await run(`document.querySelector('[data-family="plus"] .account-group-alert').textContent`),'5');
    assert.equal(await run(`document.activeElement.dataset.family`),'plus');
    await click('[data-action="startSelection"]');
    assert.equal(await run(`document.querySelectorAll('.account-group-actions button').length`),4);
    assert.equal(await run(`document.querySelector(${JSON.stringify(move('pro',-1))}).disabled`),true);
    await click('[data-profile="长任务备用"] .account-select');
    await click(move('plus',-1));
    assert.deepEqual(await order(), ['plus','pro']);
    assert.equal(await run(`document.querySelector('[data-profile="长任务备用"] .account-select').checked`),true);
    assert.equal(await run(`exportSelection.size`),1);
    await pause(50);
    fs.writeFileSync(outputPath('account-groups-manage.png'),(await window.webContents.capturePage()).toPNG());

    await run(`$('accountSearch').value='缺少5h';$('accountSearch').dispatchEvent(new Event('input',{bubbles:true}))`);
    assert.equal(await run(`document.querySelector('[data-family="plus"] .accounts-grid').hidden`),false);
    assert.equal(await run(`document.querySelector('.account-group-toggle').disabled`),true);
    assert.equal(await run(`[...document.querySelectorAll('.account-group-actions button')].every(b=>b.disabled)`),true);
    await run(`$('accountSearch').value='';$('accountSearch').dispatchEvent(new Event('input',{bubbles:true}))`);
    assert.deepEqual(await order(), ['plus','pro']);
    assert.equal(await run(`document.querySelector('[data-family="plus"] .accounts-grid').hidden`),true);
    await click('[data-action="endSelection"]');
    assert.equal(await run(`document.querySelectorAll('.account-group-actions').length`),0);
    await run(`renderWorkbench()`);
    assert.equal(await run(`document.querySelector('[data-family="plus"] .accounts-grid').hidden`),true);
    assert.equal(await run(`window.testApi.calls().length`),accountCalls,'Display changes must not operate on accounts');
    await window.webContents.reload();
    await pause(300);
    await setup();
    assert.deepEqual(await order(), ['plus','pro']);
    assert.equal(await run(`document.querySelector('[data-family="plus"] .accounts-grid').hidden`),true);
    await click('[data-action="setAccountLayout"][data-layout="rows"]');
    assert.equal(await run(`getComputedStyle(document.querySelector('[data-family="plus"] .accounts-grid')).display`),'none');
    await click(fold('plus'));
    await run(`{const p=structuredClone(agentsData[0].profiles[1]);p.name='新套餐';p.meta.snapshot.plan='team';agentsData[0].profiles.push(p);renderWorkbench();}`);
    assert.deepEqual(await order(), ['plus','pro','team']);

    window.setSize(636,900);
    await run(`writeLayout('sidebarCollapsed','true');applySidebar();startSelection()`);await pause(40);
    assert.deepEqual((await geometry()).overflow,[],'Group controls fit while managing accounts at minimum width');
    await click('[data-action="endSelection"]');
    await run(`writeLayout('accountGroups.codex','{invalid');renderWorkbench()`);
    assert.deepEqual(await order(), ['pro','plus','team']);
    await run(`(async()=>{await window.providerTestApi.setup();await loadStatus();selectTab('agy');})()`);
    assert.equal(await run(`document.querySelectorAll('.account-group-toggle,.account-group-actions,.card-resources').length`),0);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:true,initial,checks:'Missing periods, compact errors, fold/move/search/reload/selection, both layouts, non-quota Agent'}));
    app.exit(0);
  } catch (error) {
    console.error(error, errors);
    fs.writeFileSync(outputPath('account-groups-error.png'),(await window.webContents.capturePage()).toPNG());
    app.exit(1);
  }
});
