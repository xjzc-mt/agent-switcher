const outputPath = require('./ui-support.cjs');
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
  const w=new BrowserWindow({width:1120,height:740,show:false,webPreferences:{preload:path.join(__dirname,'fixture-preload.cjs'),contextIsolation:true}});
  const errors=[];w.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
  const run=s=>w.webContents.executeJavaScript(s);
  const close=()=>run(`{const d=document.querySelector('dialog[open]');d.querySelector('[data-close-dialog]').click();d.dismissAccountDialog();}`);
  try{
    await w.loadFile(path.join(process.env.AGS_UI_RENDERER_ROOT||path.join(__dirname,'../renderer'),'index.html'));await pause(300);
    await run(`localStorage.clear();accountLayout='cards';applySidebar();
      { const a=agentsData[0],base=structuredClone(a.profiles[0]),now=Date.now();
        a.profiles=Array.from({length:10},(_,i)=>{const p=structuredClone(base);p.name=['当前工作','个人主力','日常开发','文档写作','长任务','重构','备用','测试','很长的账号昵称需要省略显示','缓存账号'][i];p.isActive=i===0;p.meta.email='long-account-'+i+'@example.test';p.meta.label=p.name;
          p.meta.snapshot.plan=i<4?'plus':i===7?'free':'pro';p.meta.snapshot.fetchedAt=new Date(now).toISOString();p.meta.snapshot.quota.credits={balance:i===1?'579.03':i===4?'120':i===6?'-2.35':'0'};
          p.meta.snapshot.quota.primaryWindow.usedPercent=100-[82,100,70,0][i%4];
          p.meta.snapshot.quota.secondaryWindow.usedPercent=100-[65,8,20,80,78,53,0,100,35,60][i];
          if(i>=4)delete p.meta.snapshot.quota.primaryWindow;
          if(i===7)p.meta.snapshot.quota.secondaryWindow.windowMins=43200;
          if(i===9)p.meta.snapshot.fetchedAt=new Date(now-600000).toISOString();
          if(i===0||i===1||i===4)p.meta.snapshot.quota.resetCredits={availableCount:2,credits:i===1?null:[{id:'r',status:'available',resetType:'codexRateLimits',expiresAt:Math.floor(now/1000)+7200,title:'额度重置卡',description:'重置 Codex 额度'}]};
          return p;});a.status=a.profiles[0].meta.snapshot;$('badge-count-codex').textContent=a.profiles.length;syncSidebarLabels();selectTab('codex');
      }`);
    const quotaCases=await run(`(()=>{
      const status=structuredClone(agentsData[0].status),host=document.createElement('div');
      const cases=[[100,8],[0,80],[80,30],[79,31],[79.6,30.4],[0.2,100]];
      const read=()=>{host.innerHTML=quotaCells(status);return [...host.querySelectorAll('.quota-cell')].map(cell=>({state:cell.dataset.valueState,value:cell.querySelector('.quota-value').textContent,label:cell.getAttribute('aria-label')}));};
      const values=cases.map(([short,week])=>{status.quota.primaryWindow.usedPercent=100-short;status.quota.secondaryWindow.usedPercent=100-week;return read();});
      status.quota.primaryWindow.resetsAt=Date.now()/1000-1;
      const reset=read();status.fetchedAt=new Date(Date.now()-600000).toISOString();
      return {values,reset,stale:read()};
    })()`);
    assert.deepEqual(quotaCases.values.map(pair=>pair.map(cell=>cell.state)),[['ample','low'],['zero','ample'],['ample','low'],['normal','normal'],['ample','low'],['low','ample']]);
    assert.equal(quotaCases.values[5][0].value,'<1%');assert.match(quotaCases.values[5][0].label,/<1%/);
    assert.deepEqual(quotaCases.reset.map(cell=>cell.state),['cached','ample']);
    assert.deepEqual(quotaCases.stale.map(cell=>cell.state),['cached','ample'],'Refresh age must not gray the unreset weekly window');
    assert.match(quotaCases.stale[1].label,/上次查询/);
    const quotaNumberOverlaps=()=>run(`[...document.querySelectorAll('.account-card .quota-cell-line')].flatMap(line=>{const number=line.querySelector('.quota-number'),reset=line.querySelector('.quota-reset');if(!number||!reset?.offsetWidth)return [];const range=document.createRange();range.selectNodeContents(number);const n=range.getBoundingClientRect(),r=reset.getBoundingClientRect();return n.right>r.left+0.01&&Math.min(n.bottom,r.bottom)>Math.max(n.top,r.top)?[{number:number.textContent,reset:reset.textContent,overlap:n.right-r.left}]:[];})`);
    const rows=[];
    const dimensions = [[636,true], [748,false], [880,true], [1440,false]];
    for(const layout of ['cards','rows'])for(const [width,collapsed] of dimensions){
      w.setSize(width,740);await run(`accountLayout='${layout}';writeLayout('sidebarCollapsed','${collapsed}');applySidebar();renderWorkbench()`);await pause(40);
      const geometry=await run(`(()=>{const section=document.querySelector('.account-section'),cards=[...document.querySelectorAll('.account-card')],overlap=[];
        for(const card of cards){const actions=card.querySelector('.card-actions').getBoundingClientRect(),resources=card.querySelector('.card-resources').getBoundingClientRect();if(Math.min(actions.right,resources.right)-Math.max(actions.left,resources.left)>1&&Math.min(actions.bottom,resources.bottom)-Math.max(actions.top,resources.top)>1)overlap.push(card.dataset.profile);
          const marker=card.querySelector('.credit-corner');if(marker){const mr=marker.getBoundingClientRect();for(const e of card.querySelectorAll('.quota-reset,.quota-value')){const r=e.getBoundingClientRect();if(Math.min(mr.right,r.right)-Math.max(mr.left,r.left)>1&&Math.min(mr.bottom,r.bottom)-Math.max(mr.top,r.top)>1)overlap.push(card.dataset.profile+':corner');}}}
        const actionGaps=cards.map(card=>{const actions=card.querySelector('.card-actions').getBoundingClientRect(),resources=card.querySelector('.card-resources').getBoundingClientRect();return actions.left-resources.right;});
        const list=$('accountGrid').getBoundingClientRect(),pool=section.getBoundingClientRect(),heading=section.querySelector('.matrix-section-header').getBoundingClientRect();
        return {layout:'${layout}',width:${width},collapsed:${collapsed},pool:section.clientWidth,centered:Math.abs(list.left-pool.left-(pool.right-list.right))<1,headingFull:Math.abs(heading.width-pool.width)<1,columns:getComputedStyle(document.querySelector('.accounts-grid')).gridTemplateColumns.split(' ').length,overflow:[...document.querySelectorAll('.account-plan-group,.account-card,.card-resources,.quota-cells,.quota-cell,.quota-cell-line')].filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>[e.className,e.clientWidth,e.scrollWidth]),overlap,actionGaps,outer:document.documentElement.scrollWidth>innerWidth,widths:cards.map(c=>c.offsetWidth),heights:cards.map(c=>c.offsetHeight)};})()`);
      assert.equal(geometry.outer,false,JSON.stringify(geometry));assert.deepEqual(geometry.overflow,[],JSON.stringify(geometry));assert.deepEqual(geometry.overlap,[],JSON.stringify(geometry));
      assert.deepEqual(await quotaNumberOverlaps(),[],`Quota text must not intersect reset text: ${layout}, ${width}, collapsed=${collapsed}`);
      if(layout==='cards'){
        const columns=geometry.columns;
        const cardWidth=Math.min(208,(geometry.pool-(columns-1)*8)/columns);
        assert.ok(geometry.widths.every(width=>Math.abs(width-cardWidth)<1),JSON.stringify(geometry));
        assert.ok(cardWidth>=180,JSON.stringify(geometry));
        assert.ok((columns+1)*180+columns*8>geometry.pool,JSON.stringify(geometry));
      }else{
        assert.ok(geometry.heights.every(h=>h===44),JSON.stringify(geometry));
        assert.ok(geometry.actionGaps.every(gap=>gap>=0),JSON.stringify(geometry));
        assert.equal(geometry.centered,true,JSON.stringify(geometry));assert.equal(geometry.headingFull,true,JSON.stringify(geometry));
      }
      rows.push(geometry);
      if((width===748&&!collapsed)||(width===636&&collapsed))fs.writeFileSync(outputPath(`accounts-${layout}-minimum-${collapsed?'collapsed':'expanded'}.png`),(await w.webContents.capturePage()).toPNG());
      if(layout==='cards'&&width===880&&collapsed){
        assert.equal(await run(`(()=>{const cards=[...document.querySelectorAll('[data-family="pro"] .account-card')];return cards.slice(0,${geometry.columns}).every(card=>card.getBoundingClientRect().y===cards[0].getBoundingClientRect().y)&&cards[${geometry.columns}].getBoundingClientRect().y>cards[0].getBoundingClientRect().y;})()`),true);
        fs.writeFileSync(outputPath('accounts-responsive-collapsed.png'),(await w.webContents.capturePage()).toPNG());
      }
      if(layout==='cards'&&width===1440&&!collapsed)fs.writeFileSync(outputPath('accounts-cards-wide.png'),(await w.webContents.capturePage()).toPNG());
      if(layout==='rows'&&width===1440&&!collapsed)fs.writeFileSync(outputPath('accounts-rows-wide.png'),(await w.webContents.capturePage()).toPNG());
    }
    await run(`accountLayout='cards';writeLayout('sidebarCollapsed','false');applySidebar();renderWorkbench()`);w.setSize(1120,740);await pause(50);
    await run(`{const p=agentsData[0].profiles[8];p.meta.snapshot.plan='prolite';p.meta.snapshot.quota.secondaryWindow={usedPercent:0,resetsAt:Math.floor(Date.now()/1000)+2590000};p.meta.snapshot.quota.resetCredits={availableCount:120,credits:null};p.meta.snapshot.quota.credits={balance:'0.001'};renderWorkbench();}`);
    w.setSize(920,620);await pause(50);
    const edge=await run(`(()=>{const c=document.querySelector('[data-profile="很长的账号昵称需要省略显示"]');return {overflow:[c,...c.querySelectorAll('.card-resources,.quota-cells,.quota-cell-line')].filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.className),tier:c.querySelector('.plan-tier')?.textContent,ticket:c.querySelector('.reset-ticket').textContent,tip:c.querySelector('.credit-corner').dataset.tooltip};})()`);
    assert.deepEqual(edge.overflow,[],JSON.stringify(edge));assert.equal(edge.tier,'Pro·100');assert.match(edge.ticket,/99\+/);assert.match(edge.tip,/<0.01/);
    w.setSize(1120,740);await pause(50);
    const selector='[data-profile="个人主力"]';
    const hover=async suffix=>{await run(`document.querySelector('${selector+suffix}').dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}))`);await pause(600);const t=await run(`document.querySelector('[role=tooltip]')?.textContent||''`);await run(`document.querySelector('${selector+suffix}').dispatchEvent(new PointerEvent('pointerout',{bubbles:true,pointerType:'mouse'}))`);return t;};
    assert.equal(await hover(''),'');assert.ok(!(await hover(' .account-main-name')).includes('Credits'));assert.match(await hover(' .credit-corner'),/Credits 579.03/);
    // Fixed information targets respond in the same pointer event, without the text-tooltip delay.
    await run(`agentsData[0].profiles[1].meta.snapshot.quota.credits.balance='579.1234567';renderWorkbench();document.querySelector('${selector} .credit-corner').dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}))`);
    assert.equal(await run(`document.querySelector('[role=tooltip]')?.textContent`),'Credits 579.12');
    await run(`document.querySelector('${selector} .credit-corner').dispatchEvent(new PointerEvent('pointerout',{bubbles:true,pointerType:'mouse'}));
      {const tomorrow=new Date();tomorrow.setDate(tomorrow.getDate()+1);tomorrow.setHours(23,59,0,0);agentsData[0].profiles[1].meta.snapshot.quota.resetCredits.credits=[{status:'available',expiresAt:tomorrow.getTime()/1000}];renderWorkbench();}
      document.querySelector('${selector} .reset-ticket').dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}))`);
    assert.match(await run(`document.querySelector('[role=tooltip]')?.textContent`),/最近一张明天到期/);
    assert.equal(await run(`document.querySelector('${selector} .reset-ticket').classList.contains('expiring')`),true);
    await run(`document.querySelector('${selector} .reset-ticket').dispatchEvent(new PointerEvent('pointerout',{bubbles:true,pointerType:'mouse'}));agentsData[0].profiles[1].meta.snapshot.quota.resetCredits.credits=null;agentsData[0].profiles[1].meta.snapshot.quota.credits.balance='579.03';renderWorkbench()`);
    assert.equal(await hover(' .quota-value'),'');
    await run(`document.querySelector('${selector} .credit-corner').click()`);assert.equal(await run(`document.querySelector('dialog[open]')===null`),true);
    await run(`document.querySelector('${selector}').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}))`);assert.match(await run(`document.querySelector('dialog[open]').textContent`),/579.03/);await close();
    await run(`document.querySelector('${selector} .reset-ticket').click()`);assert.match(await run(`document.querySelector('dialog[open]').textContent`),/重置卡 2 张/);assert.match(await run(`document.querySelector('dialog[open]').textContent`),/适用范围和有效期待刷新/);assert.equal(await run(`document.querySelector('dialog[open] [data-action*=redeem]')`),null);await close();
    await run(`accountLayout='rows';agentsData[0].profiles[1].meta.snapshot.quota.credits.balance='1234567890.12';renderWorkbench()`);await pause(40);
    assert.match(await hover(' .credit-badge b'),/1,234,567,890.12/);
    assert.equal(await run(`document.querySelector('${selector} .reset-ticket')?.textContent`),'2','Row actions must retain the reset-card entry');
    await run(`agentsData[0].profiles[5].meta.snapshot.quota.primaryWindow=structuredClone(agentsData[0].profiles[1].meta.snapshot.quota.primaryWindow);renderWorkbench()`);
    for(const [dates,width] of [[false,1120],[true,748]]){
      w.setSize(width,740);await run(`settings.showResetTimes=${!dates};renderWorkbench()`);await pause(40);
      const mixed=await run(`(()=>{const group=document.querySelector('[data-family="pro"]'),head=group.querySelector('.row-credit-head').getBoundingClientRect(),pro=group.querySelector('[data-profile="重构"]'),plus=document.querySelector('[data-family="plus"] .account-card'),pr=pro.getBoundingClientRect(),pq=[...pro.querySelectorAll('.quota-cell')],pp=[...plus.querySelectorAll('.quota-cell')];return {periods:pq.map(el=>el.querySelector('.quota-label').textContent),height:pr.height,contained:pq.every(el=>{const r=el.getBoundingClientRect();return r.top>=pr.top&&r.bottom<=pr.bottom;}),slotsAligned:Math.abs(pro.querySelector('.card-resources').getBoundingClientRect().left-pp[0].getBoundingClientRect().left)<1&&Math.abs(pro.querySelector('.card-resources .plan-tier').getBoundingClientRect().left-pp[1].getBoundingClientRect().left)<1,overflow:[group,...group.querySelectorAll('.account-card,.card-resources,.quota-cells,.quota-cell-line')].filter(el=>el.scrollWidth>el.clientWidth+1).map(el=>el.className),aligned:[...group.querySelectorAll('.credit-badge')].every(el=>Math.abs(el.getBoundingClientRect().left-head.left)<1)};})()`);
      assert.deepEqual(mixed.periods,['5h','7d']);assert.equal(mixed.height,44);assert.equal(mixed.contained,true);assert.equal(mixed.slotsAligned,true,JSON.stringify(mixed));assert.deepEqual(mixed.overflow,[],JSON.stringify(mixed));assert.equal(mixed.aligned,true);
      assert.deepEqual(await quotaNumberOverlaps(),[],`Mixed quotas at ${width}px, dates=${dates}`);
    }
    await run(`{const s=agentsData[0].profiles[5].meta.snapshot;window.savedStressSnapshot=structuredClone(s);s.state='error';s.quota.primaryWindow.usedPercent=0;s.quota.secondaryWindow.usedPercent=0;s.quota.credits={balance:'1234567890.12'};s.quota.resetCredits={availableCount:120,credits:null};}`);
    const stressHeads=[];
    for(const width of [748,636]){
      w.setSize(width,900);await run(`settings.showResetTimes=false;writeLayout('sidebarCollapsed','${width===636}');applySidebar();renderWorkbench()`);await pause(40);
      assert.deepEqual(await quotaNumberOverlaps(),[],`Minimum with mixed dates, credits, tickets and query warning at ${width}px`);
      const warning=await run(`(()=>{const c=document.querySelector('[data-profile="重构"].account-card'),w=c.querySelector('.account-query-warning'),r=c.querySelector('.card-resources').getBoundingClientRect();return {height:c.offsetHeight,ticket:c.querySelector('.reset-ticket').textContent,warningOverlap:w.getBoundingClientRect().right-r.left};})()`);
      assert.equal(warning.height,44);assert.match(warning.ticket,/99\+/);assert.ok(warning.warningOverlap<=0.01,JSON.stringify(warning));
      fs.writeFileSync(outputPath('accounts-rows-stress-expanded-'+width+'.png'),(await w.webContents.capturePage()).toPNG());
      await run(`document.querySelector('.account-group-toggle[data-family="pro"]').click()`);
      await pause(50);
      stressHeads.push({width,...await run(`(()=>{const h=document.querySelector('[data-family="pro"] .account-group-head'),left=h.querySelector('.row-action-head').getBoundingClientRect().left,name=h.querySelector('.account-group-name'),count=h.querySelector('.group-count').getBoundingClientRect(),alert=h.querySelector('.account-group-alert').getBoundingClientRect();return {nameVisible:name.clientWidth>=name.scrollWidth,countAlertGap:alert.left-count.right,items:[...h.querySelectorAll('h4 svg,.group-count,.account-group-alert')].map(el=>({name:el.className.baseVal??el.className,right:el.getBoundingClientRect().right-left})),outer:document.documentElement.scrollWidth>innerWidth};})()`)});
      fs.writeFileSync(outputPath('accounts-rows-stress-collapsed-'+width+'.png'),(await w.webContents.capturePage()).toPNG());
      await run(`document.querySelector('.account-group-toggle[data-family="pro"]').click()`);
    }
    assert.ok(stressHeads.every(h=>!h.outer&&h.nameVisible&&h.countAlertGap>=0&&h.items.every(item=>item.right<=0.01)),JSON.stringify(stressHeads));
    await run(`agentsData[0].profiles[5].meta.snapshot=window.savedStressSnapshot;delete window.savedStressSnapshot;writeLayout('sidebarCollapsed','false');applySidebar();renderWorkbench()`);
    const listGeometry=()=>run(`(()=>{const pool=document.querySelector('.account-section').getBoundingClientRect(),list=$('accountGrid').getBoundingClientRect(),card=[...document.querySelectorAll('.account-card')].find(c=>c.offsetHeight),name=card.querySelector('.account-main-name'),resource=card.querySelector('.card-resources').getBoundingClientRect(),actions=card.querySelector('.card-actions').getBoundingClientRect();return {width:list.width,pool:pool.width,left:list.left,gutter:list.left-pool.left,name:name.getBoundingClientRect().width,resourceWidth:resource.width,actionWidth:actions.width,resourceOffset:resource.left-list.left,creditHeads:document.querySelectorAll('.row-credit-head').length,creditBadges:document.querySelectorAll('#accountGrid .credit-badge').length,centered:Math.abs(list.left-pool.left-(pool.right-list.right))<1};})()`);
    await run(`{window.savedLayoutProfiles=structuredClone(agentsData[0].profiles);const a=agentsData[0];a.profiles.forEach((p,i)=>{p.meta.label=i?'备用'+i:'当前';p.meta.snapshot.quota.credits={balance:'0'};});settings.showResetTimes=true;renderWorkbench();}`);
    w.setSize(1120,900);await pause(40);
    const short=await listGeometry();assert.equal(short.creditHeads,0);assert.equal(short.creditBadges,0);assert.ok(short.name>=79,JSON.stringify(short));assert.equal(short.centered,true);assert.ok(short.gutter>0);
    fs.writeFileSync(outputPath('accounts-rows-short-no-credits.png'),(await w.webContents.capturePage()).toPNG());
    await run(`agentsData[0].profiles[0].meta.label='当前账号的超长名称不应影响备用列表宽度';renderWorkbench()`);
    const activeLongest=await listGeometry();assert.ok(Math.abs(activeLongest.width-short.width)<1,'The active account name must not widen the backup list');
    await run(`{const a=agentsData[0];a.profiles[0].isActive=false;a.profiles[1].isActive=true;a.status=a.profiles[1].meta.snapshot;renderWorkbench();}`);
    const backupLongest=await listGeometry();assert.ok(backupLongest.width>short.width,'The long name must widen the list once that account becomes a backup');
    assert.ok(backupLongest.name>240,'The longest backup name must not retain the old 240px cap');
    await run(`{const a=agentsData[0];a.profiles[0].isActive=true;a.profiles[1].isActive=false;a.status=a.profiles[0].meta.snapshot;renderWorkbench();}`);
    assert.ok(Math.abs((await listGeometry()).width-short.width)<1,'Making the long-named account active again must restore the short backup width');
    await run(`{const a=agentsData[0];a.profiles[0].meta.label='当前';a.profiles[4].meta.label='这个备用账号名称用于调整列表宽度';a.profiles[4].meta.snapshot.plan='promax';a.profiles[4].meta.snapshot.quota.credits={balance:'1234567890123.45'};renderWorkbench();}`);
    const wide=await listGeometry();assert.ok(wide.width>556&&wide.width<wide.pool,JSON.stringify(wide));assert.ok(wide.creditHeads>1);assert.equal(wide.creditBadges,1);
    const balances=await run(`(()=>{const b=document.querySelector('#accountGrid .credit-badge'),n=b.querySelector('b'),heads=[...document.querySelectorAll('.row-credit-head')];return {width:b.getBoundingClientRect().width,truncated:n.scrollWidth>n.clientWidth,label:n.dataset.tooltip,aligned:heads.every(h=>Math.abs(h.getBoundingClientRect().left-b.getBoundingClientRect().left)<1)};})()`);
    assert.equal(balances.width,80);assert.equal(balances.truncated,true);assert.match(balances.label,/1,234,567,890,123.45/);assert.equal(balances.aligned,true);
    await run(`document.querySelector('.account-group-toggle[data-family="pro"]').click()`);
    assert.ok(Math.abs((await listGeometry()).width-wide.width)<1,'Folding must preserve the saved-name baseline');
    await run(`$('accountSearch').value='备用2';$('accountSearch').dispatchEvent(new Event('input',{bubbles:true}))`);
    const filtered=await listGeometry();assert.ok(Math.abs(filtered.width-wide.width)<1);assert.equal(filtered.creditHeads,1);assert.equal(filtered.creditBadges,0);assert.ok(Math.abs(filtered.resourceOffset-wide.resourceOffset)<1,'Filtering out the only Credits account must preserve column positions');
    await run(`$('accountSearch').value='';$('accountSearch').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.account-group-toggle[data-family="pro"]').click()`);
    const intermediateWidth=Math.ceil(wide.width+192+40);w.setSize(intermediateWidth,900);await pause(50);
    const intermediate=await listGeometry();assert.ok(Math.abs(intermediate.width-wide.width)<1);assert.ok(intermediate.gutter<wide.gutter&&intermediate.gutter>0,JSON.stringify({wide,intermediate}));
    w.setSize(748,900);await pause(50);
    const narrow=await listGeometry();assert.ok(Math.abs(narrow.width-narrow.pool)<1);assert.ok(narrow.name<wide.name);assert.equal(narrow.centered,true);assert.equal(narrow.resourceWidth,wide.resourceWidth);assert.equal(narrow.actionWidth,wide.actionWidth);
    const longName=await run(`(()=>{const n=document.querySelector('[data-profile="长任务"] .account-main-name');return {truncated:n.scrollWidth>n.clientWidth,overflow:getComputedStyle(n).textOverflow,tip:n.dataset.tooltip};})()`);
    assert.equal(longName.truncated,true);assert.equal(longName.overflow,'ellipsis');assert.match(longName.tip,/这个备用账号名称用于调整列表宽度/);
    fs.writeFileSync(outputPath('accounts-rows-long-name-minimum.png'),(await w.webContents.capturePage()).toPNG());
    w.setSize(748,1020);
    await run(`{const a=agentsData[0],base=a.profiles[1];a.profiles=[a.profiles[0],...['enterprise','business','team','edu','go','free','unknown'].map((plan,i)=>{const p=structuredClone(base);p.name='套餐'+i;p.meta.label=p.name;p.meta.snapshot.plan=plan;delete p.meta.snapshot.quota.resetCredits;if(plan==='go'||plan==='free')delete p.meta.snapshot.quota.primaryWindow;if(plan==='free')p.meta.snapshot.quota.secondaryWindow.windowMins=43200;if(plan==='unknown')delete p.meta.snapshot.quota;return p;})];$('badge-count-codex').textContent=a.profiles.length;syncSidebarLabels();settings.showResetTimes=false;renderWorkbench();}`);
    const readPlanHeads=()=>run(`[...document.querySelectorAll('.account-group-head')].map(h=>{const title=h.querySelector('.account-group-toggle'),columns=h.querySelector(h.closest('.is-collapsed')?'.row-action-head':'.row-column-head');return {label:title.textContent,overlap:Math.max(...[...h.querySelectorAll('h4 button')].map(b=>b.getBoundingClientRect().right))-columns.getBoundingClientRect().left,overflow:h.scrollWidth>h.clientWidth+1};})`);
    const planHeads=await readPlanHeads();
    fs.writeFileSync(outputPath('accounts-rows-all-plans-minimum.png'),(await w.webContents.capturePage()).toPNG());
    assert.equal(planHeads.length,7);assert.ok(planHeads.every(h=>h.overlap<=1&&!h.overflow),JSON.stringify(planHeads));
    await run(`document.querySelector('[data-family="enterprise"] .account-group-name').dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}))`);await pause(600);
    assert.equal(await run(`document.querySelector('[role=tooltip]')?.textContent`),'Enterprise');
    await run(`document.querySelector('[data-family="enterprise"] .account-group-name').dispatchEvent(new PointerEvent('pointerout',{bubbles:true,pointerType:'mouse'}));document.querySelector('.account-group-toggle[data-family="unknown"]').click()`);
    const collapsedHeads=await readPlanHeads();assert.ok(collapsedHeads.every(h=>h.overlap<=1&&!h.overflow),JSON.stringify(collapsedHeads));
    await run(`agentsData[0].profiles=window.savedLayoutProfiles;agentsData[0].status=agentsData[0].profiles[0].meta.snapshot;delete window.savedLayoutProfiles;settings.showResetTimes=true;renderWorkbench()`);
    assert.equal(await run(`creditInfo({state:'ok',fetchedAt:new Date().toISOString(),quota:{credits:{balance:'0'}}}).available`),false);
    assert.equal(await run(`creditInfo({state:'ok',fetchedAt:new Date().toISOString(),quota:{credits:{balance:null,hasCredits:true}}}).balance`),'—');
    assert.equal(await run(`creditInfo({state:'ok',fetchedAt:new Date().toISOString(),quota:{credits:{balance:'-2.35'}}}).negative`),true);
    await run(`setAccountLayout(null,null,{dataset:{layout:'rows'}})`);await w.webContents.reload();await pause(300);assert.equal(await run(`accountLayout`),'rows');
    await run(`localStorage.clear()`);assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,layoutCases:rows.length,rows,creditsHover:'fixed corner',resetCards:'actual count; unknown details preserved',errors}));app.exit(0);
  }catch(e){console.error(e);fs.writeFileSync(outputPath('agent-switcher-layout-error.png'),(await w.webContents.capturePage()).toPNG());app.exit(1);}
});
