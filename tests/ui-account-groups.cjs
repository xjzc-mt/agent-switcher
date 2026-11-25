const suite = require('./ui-support.cjs');
const assert = require('node:assert/strict');

module.exports = suite(
  { width: 1120, height: 900 },
  async ({ window, run, load, pause, click, capture }) => {
    const order = () => run(`[...document.querySelectorAll('.account-plan-group[data-family]')].map(g=>g.dataset.family)`);
    const fold = family => `.account-group-toggle[data-family="${family}"]`;
    const move = (family, direction) => `[data-action="moveAccountGroup"][data-family="${family}"][data-direction="${direction}"]`;
    const setup = () => run(`{
      const agent=agentsData[0],active=structuredClone(agent.profiles[0]),now=Date.now();
      const make=(name,plan,short,week,state='ok',flags={})=>{
        const status={available:true,state,plan,fetchedAt:new Date(now).toISOString(),quota:{},...flags};
        if(short!==null)status.quota.primaryWindow={usedPercent:100-short,windowMins:300,resetsAt:now/1000+3600};
        if(week!==null)status.quota.secondaryWindow={usedPercent:100-week,windowMins:10080,resetsAt:now/1000+345600};
        if(short===null&&week===null)delete status.quota;
        return {name,meta:{label:name,email:'account@example.test',snapshot:status}};
      };
      agent.profiles=[active,
        make('长任务备用','prolite',null,100),make('主力开发','pro',null,80),
        make('短期充足','plus',100,55),make('缺少5h','plus',null,9),make('缺少7d','plus',90,null),
        make('缓存查询','plus',85,62,'error'),make('首次查询','plus',null,null,'error'),make('刚导入','plus',null,null,'unverified'),
        make('失效Plus','plus',100,90,'expired'),make('鉴权拒绝','pro',50,60,'error',{authFailure:'authentication-rejected'}),
        make('候选凭据','prolite',null,null,'unverified',{stagedReplacement:true}),make('文件损坏',null,null,null,'error',{available:false})];
      $('badge-count-codex').textContent=agent.profiles.length;syncSidebarLabels();
      accountLayout='cards';selectTab('codex');
    }`);
    const invalid = '[data-family="__invalid__"]', foldInvalid = fold('__invalid__');
    const invalidPlans = () => run(`Object.fromEntries([...document.querySelectorAll('${invalid} .account-card')].map(c => [c.dataset.profile, c.querySelector('.plan-tier')?.textContent ?? '']))`);
    const plans = { '失效Plus':'Plus', '鉴权拒绝':'Pro·200', '候选凭据':'Pro·100', '文件损坏':'' };
    const geometry = () => run(`(()=>{
      const cards=[...document.querySelectorAll('.account-card')],get=name=>cards.find(c=>c.dataset.profile===name);
      return {heights:Object.fromEntries(cards.map(c=>[c.dataset.profile,c.offsetHeight])),
        missing:['缺少5h','缺少7d'].map(name=>[...get(name).querySelectorAll('.quota-cell')].map(c=>[c.querySelector('.quota-label').textContent,c.querySelector('.quota-value').textContent,c.querySelector('.quota-reset').textContent])),
        cached:get('缓存查询').querySelectorAll('.quota-cell.cached').length,
        overflow:[...document.querySelectorAll('.account-plan-group,.account-group-head,.account-card,.card-resources,.quota-cell-line')].filter(e=>e.clientWidth&&e.scrollWidth>e.clientWidth+1).map(e=>e.className)};
    })()`);

    await load();
    await run(`localStorage.clear();applySidebar()`);
    await setup();
    assert.deepEqual(await order(), ['pro','plus','__invalid__']);
    assert.deepEqual(await invalidPlans(), plans);
    assert.equal(await run(`document.querySelector('[data-family="pro"] .account-card').dataset.profile`),'主力开发');
    const initial = await geometry();
    assert.equal(initial.heights['短期充足'],103);
    for (const name of ['缺少5h','缺少7d','缓存查询']) assert.equal(initial.heights[name],initial.heights['短期充足']);
    assert.equal(initial.heights['主力开发'],84);
    assert.ok(initial.heights['失效Plus'] <= initial.heights['主力开发'] + 1);
    const mixedRows = await run(`(()=>{
      const rows = new Map();
      for (const card of document.querySelectorAll('[data-family="plus"] .account-card')) {
        const {top, bottom} = card.getBoundingClientRect();
        const row = rows.get(top) || []; row.push({bottom, quota:!!card.querySelector('.quota-cell')}); rows.set(top,row);
      }
      return [...rows.values()].filter(row=>row.some(c=>c.quota) && row.some(c=>!c.quota));
    })()`);
    assert.ok(mixedRows.length > 0 && mixedRows.every(row=>row.every(c=>c.bottom === row[0].bottom)), 'Mixed card rows must have aligned bottom edges');
    assert.deepEqual(initial.missing[0][0], ['5h','—','未提供']);
    assert.deepEqual(initial.missing[1][1], ['7d','—','未提供']);
    assert.equal(initial.cached,2);
    assert.deepEqual(initial.overflow,[]);
    assert.equal(await run(`document.querySelectorAll('.account-group-actions').length`),0);
    await pause(50);
    await capture('account-groups-cards.png');
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
    assert.equal(await run(`document.querySelector(${JSON.stringify(move('plus',1))}).disabled`),true);
    assert.equal(await run(`document.querySelector('${invalid} .account-group-actions')`),null);
    await click('[data-profile="失效Plus"] .account-select');
    assert.ok(await run(`['exportSelected','handleDeleteSelected'].every(a=>!document.querySelector('[data-action="'+a+'"]').disabled)`));
    await click(foldInvalid);
    await click(move('plus',-1));
    assert.deepEqual(await order(), ['plus','pro','__invalid__']);
    assert.equal(await run(`document.querySelector('[data-profile="失效Plus"] .account-select').checked`),true);
    assert.equal(await run(`exportSelection.size`),1);
    await pause(50);
    await capture('account-groups-manage.png');

    const search = text => run(`$('accountSearch').value=${JSON.stringify(text)};$('accountSearch').dispatchEvent(new Event('input',{bubbles:true}))`);
    await search('凭据失效');
    assert.deepEqual(await order(), ['__invalid__']);
    assert.deepEqual(await invalidPlans(), plans);
    assert.equal(await run(`document.querySelector('${invalid} .accounts-grid').hidden`),false);
    assert.equal(await run(`document.querySelector('.account-group-toggle').disabled`),true);
    for (const [word, profile] of [['待验证凭据','候选凭据'], ['凭据不可用','文件损坏']]) {
      await search(word);
      assert.deepEqual(await invalidPlans(), { [profile]: plans[profile] });
    }
    await search('');
    assert.deepEqual(await order(), ['plus','pro','__invalid__']);
    assert.equal(await run(`document.querySelector('[data-family="plus"] .accounts-grid').hidden`),true);
    await click('[data-action="endSelection"]');
    assert.equal(await run(`document.querySelectorAll('.account-group-actions').length`),0);
    await run(`renderWorkbench()`);
    assert.equal(await run(`document.querySelector('[data-family="plus"] .accounts-grid').hidden`),true);
    assert.equal(await run(`window.testApi.calls().length`),accountCalls,'Display changes must not operate on accounts');
    await window.webContents.reload();
    await pause(300);
    await setup();
    assert.deepEqual(await order(), ['plus','pro','__invalid__']);
    assert.equal(await run(`document.querySelector('[data-family="plus"] .accounts-grid').hidden`),true);
    await click('[data-action="setAccountLayout"][data-layout="rows"]');
    assert.equal(await run(`getComputedStyle(document.querySelector('[data-family="plus"] .accounts-grid')).display`),'none');
    assert.equal(await run(`document.querySelector('${invalid} .accounts-grid').hidden`),true);
    await click(foldInvalid);
    assert.deepEqual(await invalidPlans(), plans);
    await click(fold('plus'));
    await run(`{const p=structuredClone(agentsData[0].profiles[1]);p.name='新套餐';p.meta.snapshot.plan='team';agentsData[0].profiles.push(p);renderWorkbench();}`);
    assert.deepEqual(await order(), ['plus','pro','team','__invalid__']);

    window.setSize(636,900);
    await run(`writeLayout('sidebarCollapsed','true');applySidebar();startSelection()`);await pause(40);
    assert.deepEqual((await geometry()).overflow,[],'Group controls fit while managing accounts at minimum width');
    await click('[data-action="endSelection"]');
    await run(`writeLayout('accountGroups.codex','{invalid');renderWorkbench()`);
    assert.deepEqual(await order(), ['pro','plus','team','__invalid__']);
    const planWidths = await run(`(()=>{
      const agent=agentsData[0], sample=agent.profiles.find(p=>p.name==='失效Plus');
      agent.profiles=['pro','enterprise','subscription-with-a-very-long-custom-name'].map(plan=>({name:plan,meta:{snapshot:{...sample.meta.snapshot,plan}}}));
      renderWorkbench();
      return [...document.querySelectorAll('.credential-status .plan-tier')].map(el=>[el.textContent,el.scrollWidth>el.clientWidth+1,el.dataset.tooltip]);
    })()`);
    for (const [name,clipped,tooltip] of planWidths) {
      assert.equal(clipped,name.startsWith('subscription'),'Common plans must fit in a single invalid group at minimum window width');
      assert.equal(tooltip,name);
    }
    assert.equal(planWidths.length,3);
    await run(`(async()=>{await window.providerTestApi.setup();await loadStatus();selectTab('agy');})()`);
    assert.equal(await run(`document.querySelectorAll('.account-group-toggle,.account-group-actions,.card-resources').length`),0);
  },
);
