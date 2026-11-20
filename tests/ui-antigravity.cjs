const assert=require('node:assert/strict');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

module.exports=async function checkAntigravity(w,run) {
  await run(`{
    const a=agentsData.find(a=>a.id==='agy'),base=structuredClone(a.profiles[1]);
    a.profiles=[a.profiles[0],...Array.from({length:8},(_,i)=>{
      const p=structuredClone(base);p.name='备用 '+i;p.meta.label=p.name;
      const s=p.meta.snapshot,b=s.quota.buckets;s.plan=i===2?'Google AI Ultra':'Google AI Pro';
      b[0].windows[0].usedPercent=i*10;b[1].windows.forEach(w=>w.usedPercent=0);
      b[2].windows[0].usedPercent=100;s.quota.buckets=[b[2],b[1],b[0]];
      if(i===3)delete b[0].windows[0].usedPercent;
      if(i===4)s.quota.buckets=[b[1],b[2]];
      if(i===5)s.state='error';
      if(i===6){s.state='error';delete s.quota;}
      if(i===7){s.state='expired';s.authExpired=true;}
      return p;
    })];
    const s=a.status;s.quota.buckets.push({id:'extra',label:'模型组长名称展示示例：完整名称与多个周期',windows:[{usedPercent:16,windowMins:1440},{usedPercent:34,windowMins:43200}]});
    selectTab('agy');
  }`);
  for (const [layout, dates, width] of [['cards', true, 636], ['rows', false, 1120]]) {
    w.setSize(width,780);
    await run(`settings.showResetTimes=${!dates};accountLayout='${layout}';writeLayout('sidebarCollapsed','${width===636}');applySidebar();renderWorkbench()`);
    await pause(50);
    const result=await run(`(() => {
      const cards=[...document.querySelectorAll('.account-card')],rows='${layout}'==='rows';
      const overflow=[...document.querySelectorAll('.active-session-card,.model-quotas,.quota-summary,.quota-summary-windows,.quota-cell-line,.account-card,.card-resources,.account-group-head')].filter(e=>e.clientWidth&&e.scrollWidth>e.clientWidth+1).map(e=>({class:e.className,width:e.clientWidth,scroll:e.scrollWidth}));
      const group=document.querySelector('.account-plan-group'),card=cards.find(c=>c.dataset.profile==='备用 0');
      const head=group.querySelector('.row-model-head'),summary=card.querySelector('.quota-summary');
      return {overflow,outer:document.documentElement.scrollWidth>innerWidth,heights:cards.map(c=>c.offsetHeight),
        numberOverlaps:[...document.querySelectorAll('.account-card .quota-cell-line')].flatMap(line=>{const number=line.querySelector('.quota-number'),reset=line.querySelector('.quota-reset');if(!number||!reset?.offsetWidth)return [];const range=document.createRange();range.selectNodeContents(number);const n=range.getBoundingClientRect(),r=reset.getBoundingClientRect();return n.right>r.left+0.01&&Math.min(n.bottom,r.bottom)>Math.max(n.top,r.top)?[{number:number.textContent,overlap:n.right-r.left}]:[];}),
        aligned:!rows||Math.abs(head.getBoundingClientRect().left-summary.getBoundingClientRect().left)<1,
        labels:card.querySelector('.card-resources .quota-cells').innerText,
        summary:summary.innerText,
        summaryLine:Math.max(...[...summary.querySelectorAll('.quota-cell')].map(e=>e.offsetTop))-Math.min(...[...summary.querySelectorAll('.quota-cell')].map(e=>e.offsetTop)),
        pool:document.querySelector('#accountGrid').innerText,
        currentGroups:document.querySelectorAll('.current-quota .quota-summary').length,
        currentName:document.querySelector('.current-quota .quota-summary:last-child .quota-summary-name').innerText,
        pending:document.querySelector('[data-profile="备用 4"] .card-resources').innerText};
    })()`);
    assert.deepEqual(result.overflow,[],JSON.stringify({layout,dates,width,result}));
    assert.equal(result.outer,false);assert.equal(result.aligned,true);
    assert.deepEqual(result.numberOverlaps,[],JSON.stringify({layout,dates,width,result}));
    if(layout==='rows')assert.ok(result.heights.every(h=>h===44),JSON.stringify(result));
    assert.doesNotMatch(result.labels,/Gemini/);assert.doesNotMatch(result.pool,/Argon|模型组长名称/);
    assert.match(result.pool,/Ultra/);assert.doesNotMatch(result.pool,/Google AI/);
    assert.match(result.summary,/5h/);assert.match(result.summary,/7d/);
    assert.equal(result.summaryLine,0,'Summary periods must remain on one line');
    assert.equal(result.currentGroups,3);assert.match(result.currentName,/完整名称与多个周期/);
    assert.match(result.pending,/Gemini 额度未取得/);
  }
  await run(`settings.showResetTimes=false;accountLayout='cards';renderWorkbench()`);
  for (const width of [206, 207]) {
    const result=await run(`(() => {
      const card=document.querySelector('[data-profile="备用 0"].account-card');card.style.width='${width}px';
      const summary=card.querySelector('.quota-summary');
      return {label:summary.querySelector('.quota-summary-name').innerText,overflow:[...card.querySelectorAll('.quota-summary,.quota-cell,.quota-cell-line')].filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.className),height:summary.offsetHeight};
    })()`);
    assert.equal(result.label,width>=207?'Claude / GPT':'C/G');assert.deepEqual(result.overflow,[],JSON.stringify({width,result}));
  }
  await run(`renderWorkbench();document.querySelector('[data-profile="备用 0"].account-card').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`);
  assert.match(await run(`document.querySelector('[data-account-details]').textContent`),/Gemini 4 Argon/);
  assert.equal(await run(`document.querySelectorAll('[data-account-details] .account-actions').length`),1);
  await run(`document.querySelector('[data-account-details]').dismissAccountDialog(false)`);
  await run(`{
    const a=agentsData.find(a=>a.id==='agy');a.status.quota.buckets=[a.status.quota.buckets.find(b=>b.id==='Gemini')];renderWorkbench();
  }`);
  assert.equal(await run(`document.querySelectorAll('.current-quota .quota-summary').length`),0);
  await run(`{
    const a=agentsData.find(a=>a.id==='agy');a.status.quota.buckets.push({id:'new',label:'任意新模型组',windows:[{usedPercent:20,windowMins:1440}]});a.status.quota.buckets.shift();renderWorkbench();
  }`);
  assert.match(await run(`document.querySelector('.current-quota').textContent`),/Gemini 额度未取得/);
  assert.match(await run(`document.querySelector('.current-quota').textContent`),/任意新模型组/);
  await run(`window.providerTestApi.native();loadStatus()`);await pause(100);
};
