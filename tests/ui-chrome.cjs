const suite = require('./ui-support.cjs');
const assert = require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createTrayPanel}=require('../dist/tray-menu.js');
const { BrowserWindow, ipcMain } = require('electron');

module.exports = suite(
  { width: 880, height: 700, titleBarStyle: 'hiddenInset', trafficLightPosition: {x: 18, y: 18}, additionalArguments: ['--test-tray-menu'] },
  async ({ window, run, until, load, pause, capture }) => {
    const tray = new EventEmitter();
    tray.setIgnoreDoubleClickEvents = () => {};
    tray.getBounds = () => ({ x:320, y:0, width:20, height:24 });
    let snapshot;
    const host = createTrayPanel(tray, () => snapshot, command => window.webContents.send('tray-command', command));
    const onSnapshot = (_event, next) => { snapshot = next; host.update(); };
    ipcMain.on('fixture-tray-state', onSnapshot);
    const onReply = (_event, request, result) => host.replySwitch(request, result);
    ipcMain.on('fixture-tray-reply', onReply);
    window.once('closed', () => { ipcMain.off('fixture-tray-state', onSnapshot); ipcMain.off('fixture-tray-reply', onReply); });

    await load();
    if (process.platform === 'darwin') {
      const { Menu } = require('electron');
      const previous = Menu.getApplicationMenu();
      try {
        const send = operation => window.webContents.send('tray-command', {action:'menu', operation});
        require('../dist/application-menu').installApplicationMenu(send, () => {}, () => {}, true);
        const menu = Menu.getApplicationMenu();
        assert.equal(menu.getMenuItemById('refresh').accelerator,'Cmd+R');
        const roles = menu.items.flatMap(item => item.submenu?.items.map(entry => entry.role?.toLowerCase()) || []);
        assert.ok(roles.includes('copy') && roles.includes('paste') && !roles.includes('reload') && !roles.includes('toggledevtools'));
        await run('window.menuDocument = document; true');
        menu.getMenuItemById('refresh').click();
        const refreshed = "window.testApi.calls().some(c=>c.method==='refresh' && c.force)";
        for (let i=0; i<50 && !await run(refreshed); i++) await pause(20);
        assert.ok(await run('window.menuDocument === document && ' + refreshed));
        menu.getMenuItemById('settings').click();
        for (let i=0; i<50 && await run('currentTab') !== 'settings'; i++) await pause(20);
        assert.equal(await run('currentTab'),'settings');
        await run("selectTab('codex');openSaveModal('codex')");
        menu.getMenuItemById('agy').click(); await pause(50);
        assert.equal(await run('currentTab'),'codex');
        await run('closeSaveModal()');
      } finally { Menu.setApplicationMenu(previous); }
    }
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
    await run(`localStorage.clear();accountLayout='cards';applySidebar();renderWorkbench();window.originalCurrentHeight=document.querySelector('.active-session-card').offsetHeight;`);
    await run(`window.testApi.spendingCredits();loadStatus()`);
    for(const collapsed of [false,true]){
      const width=880;
      window.setSize(width,700);await run(`writeLayout('sidebarCollapsed','${collapsed}');applySidebar();`);await pause(100);
      const layout=await run(`(()=>{
        const current=document.querySelector('.active-session-card'),credit=current.querySelector('.current-credit-badge'),name=current.querySelector('.session-meta-group');
        const b=credit.getBoundingClientRect(),label=credit.querySelector('small').getBoundingClientRect(),value=credit.querySelector('b').getBoundingClientRect(),n=name.getBoundingClientRect(),controls=current.querySelector('.detail-header-actions').getBoundingClientRect();
        const tracks=[...current.querySelectorAll('.quota-track')].map(e=>e.getBoundingClientRect());
        const nav=document.querySelector('#nav-codex'),logo=nav.querySelector('svg').getBoundingClientRect(),nr=nav.getBoundingClientRect();
        return {height:current.offsetHeight,originalHeight:window.originalCurrentHeight,creditInHeader:!!credit.closest('.session-card-header'),creditSingleLine:Math.min(label.bottom,value.bottom)-Math.max(label.top,value.top)>Math.min(label.height,value.height)/2&&b.height<28,overlap:n.right>b.left||b.right>controls.left,quotaAligned:Math.abs(tracks[0].y-tracks[1].y)<1&&Math.abs(tracks[0].width-tracks[1].width)<1,sidebar:document.querySelector('#appSidebar').offsetWidth,navSize:[nr.width,nr.height],iconCentered:Math.abs(logo.x+logo.width/2-nr.x-nr.width/2)<1,iconSize:logo.width,badgeHidden:getComputedStyle(nav.querySelector('.nav-badge')).display==='none',label:nav.getAttribute('aria-label'),tip:nav.dataset.tooltip,toggleLeft:document.querySelector('#sidebarToggle').getBoundingClientRect().left,overflow:[current,...current.querySelectorAll('.session-card-header,.current-quota,.quota-cell-line')].filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.className)};
      })()`);
      assert.equal(layout.height,layout.originalHeight,JSON.stringify(layout));
      assert.equal(layout.creditInHeader,true);assert.equal(layout.creditSingleLine,true,JSON.stringify(layout));
      assert.equal(layout.overlap,false,JSON.stringify(layout));assert.equal(layout.quotaAligned,true);assert.deepEqual(layout.overflow,[]);
      assert.equal(layout.sidebar,collapsed?56:152);assert.match(layout.label,/4 个账号/);
      if(collapsed){assert.deepEqual(layout.navSize,[36,36]);assert.equal(layout.iconCentered,true);assert.equal(layout.iconSize,20);assert.equal(layout.badgeHidden,true);assert.match(layout.tip,/4 个账号/);assert.ok(layout.toggleLeft>=88,'Native traffic lights must have clearance');}
      await capture(`chrome-${collapsed?'collapsed':'expanded'}`);
    }
    await run(`writeLayout('sidebarCollapsed','false');applySidebar();`);window.setSize(880,700);await pause(100);
    assert.equal(await run(`document.querySelector('.current-credit-badge').hasAttribute('data-tooltip')`),false);
    assert.match(await run(`document.querySelector('.current-credit-badge').getAttribute('aria-label')`),/最近检测到余额下降/);
    await run(`agentsData[0].status.quota.credits.balance='1234567.89';renderWorkbench()`);
    assert.equal(await run(`document.querySelector('.current-credit-badge').scrollWidth<=document.querySelector('.current-credit-badge').clientWidth+1`),true);
    await run(`agentsData[0].status.quota.credits.balance='11.5';renderWorkbench();document.querySelector('#accountSearch').focus();showToast('账号额度已刷新')`);await pause(200);
    const toast=await run(`(()=>{const t=document.querySelector('.toast-item'),r=t.getBoundingClientRect(),header=document.querySelector('.workspace-topbar').getBoundingClientRect();return {centerX:r.x+r.width/2,top:r.top,bottom:r.bottom,headerBottom:header.bottom,w:innerWidth,h:innerHeight,focus:document.activeElement.id,popover:document.querySelector('#toastBox').matches(':popover-open'),role:t.getAttribute('role')};})()`);
    assert.ok(Math.abs(toast.centerX-toast.w/2)<1&&toast.top>toast.headerBottom&&toast.top<=toast.headerBottom+16&&toast.bottom<toast.h/4,JSON.stringify(toast));
    assert.equal(toast.focus,'accountSearch');assert.equal(toast.popover,true);assert.equal(toast.role,'status');await capture('chrome-top-feedback');
    await run(`showToast('第一次刷新');showToast('第二次刷新')`);assert.equal(await run(`document.querySelectorAll('.toast-item').length`),1);
    await pause(3300);assert.equal(await run(`document.querySelector('#toastBox').matches(':popover-open')`),false);
    // A refresh response can arrive while an account dialog is open.
    await run(`document.querySelector('.active-session-card').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}));showToast('账号额度已刷新')`);await pause(200);
    const modalToast=await run(`(()=>{const t=document.querySelector('.toast-item'),r=t.getBoundingClientRect();return {top:r.top,topmost:!!document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('.toast-item'),dialogs:document.querySelectorAll('dialog[open]').length};})()`);
    assert.equal(modalToast.topmost,true,JSON.stringify(modalToast));assert.equal(modalToast.dialogs,1);assert.equal(modalToast.top,toast.top,'Details must not move feedback back to the center');
    await run(`document.querySelector('.account-modal[open]').dismissAccountDialog()`);await pause(180);
    assert.equal(snapshot.menu.blocked, false, 'Removing the closed details dialog releases the main-window close guard');
    assert.equal(await run(`document.querySelector('#toastBox').parentElement===document.body&&document.querySelector('#toastBox').matches(':popover-open')`),true,'Closing details must preserve its pending feedback');
    await run(`document.querySelector('.toast-close').click()`);await until(`!document.querySelector('#toastBox').matches(':popover-open')`);
    await run(`showToast('连接失败，请稍后再试','error')`);assert.equal(await run(`document.querySelector('.toast-item').getAttribute('role')`),'alert');
    await run(`document.querySelector('.toast-close').click()`);await until(`!document.querySelector('#toastBox').matches(':popover-open')`);
    await run(`window.providerTestApi.native(); window.accountTestApi.alias('个人主力','私人-demo@example.test');
      for(let i=0;i<16;i++) window.accountTestApi.alias('团队账号','团队联合测试账号'.repeat(4)+i); loadStatus()`);
    await run(`{
      const a=agentsData[0], sign=a.profiles[1].meta.snapshot=structuredClone(a.profiles[1].meta.snapshot);
      a.status=structuredClone(a.status);
      for(const status of [a.status,sign]) {status.plan='pro';delete status.quota.primaryWindow;status.quota.secondaryWindow.usedPercent=91;}
      const statuses=a.profiles.slice(2,8).map(p=>p.meta.snapshot=structuredClone(p.meta.snapshot));
      [0,99.7,91,100].forEach((used,i)=>statuses[i].quota.primaryWindow.usedPercent=used);
      delete statuses[0].quota.secondaryWindow;
      a.status.fetchedAt = statuses[1].fetchedAt = new Date(0).toISOString();
      statuses[1].quota.secondaryWindow.usedPercent = 12;
      statuses[2].quota.primaryWindow.resetsAt = Math.floor(Date.now()/1000)-1;
      statuses[4].quota.secondaryWindow.windowMins=43200;
      statuses[5].state='error';
      syncTray(true);
    }`);
    let panel;
    const panelRun = code => panel.webContents.executeJavaScript(code);
    const key = name => {
      panel.webContents.sendInputEvent({type:'keyDown',keyCode:name});
      panel.webContents.sendInputEvent({type:'keyUp',keyCode:name});
    };
    async function panelUntil(expression) {
      for(let i=0;i<80;i++) { if(await panelRun(expression)) return; await pause(25); }
      assert.fail('Panel did not reach ' + expression + ': ' + await panelRun("document.querySelector('#panel').innerText + ' (focus ' + document.activeElement.id + ')'"));
    }
    async function openPanel() {
      if (!panel?.isVisible()) { tray.emit('mouse-down', {}); tray.emit('click', {}, tray.getBounds()); }
      for (let i=0; i<80; i++) {
        panel = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/tray.html'));
        if (panel?.isVisible()) break;
        await pause(25);
      }
      assert.ok(panel?.isVisible());
      await panelUntil("!!document.querySelector('.alternative') && innerHeight===document.querySelector('#panel').offsetHeight");
    }
    await openPanel();
    const geometry = await panelRun(`(() => {
      const box = selector=>document.querySelector(selector).getBoundingClientRect();
      const rows=[...document.querySelectorAll('.alternative')], headers=[...document.querySelectorAll('.choice-heading span')].slice(1);
      const pro=rows.find(row=>row.querySelector('.unlimited')), name=rows.find(el=>el.textContent.includes('团队联合测试账号')).querySelector('.alt-name');
      const chips=[...document.querySelectorAll('.chip[data-tone]')];
      return {count:rows.length,width:document.documentElement.scrollWidth,height:innerHeight,visibleRows:box('#choices').height/box('.alternative').height,
        aligned:rows.every(row=>[...row.querySelectorAll('.chip')].every((chip,i)=>chip.offsetLeft===headers[i].offsetLeft)),
        chipSize:chips.every(chip=>chip.offsetWidth===44&&chip.offsetHeight===19), tones:[...new Set(chips.map(chip=>chip.dataset.tone))].sort(),
        nameClipped:name.scrollWidth>name.clientWidth, pro:[pro.querySelector('.alt-identity .plan').textContent,pro.children[1].textContent,pro.children[2].textContent],
        limit:[box('.unlimited').width,box('.unlimited').height,getComputedStyle(pro.children[1]).borderStyle],
        missing:rows.some(row=>row.lastChild.textContent==='—'), boundary:!!document.querySelector('.alternative.boundary'),
        unusual:document.querySelector('.unusual').textContent, private:!document.body.innerText.includes('@'),
        hero:box('#current').height, amount:getComputedStyle(document.querySelector('.amount')).fontSize, meter:box('.meter').height,
        reset:document.querySelector('.period-reset').textContent};
    })()`);
    assert.equal(geometry.count,20);assert.equal(geometry.height,396);assert.equal(geometry.width,260);assert.equal(geometry.visibleRows,8.5);
    assert.ok(geometry.aligned && geometry.chipSize && geometry.nameClipped && geometry.private);
    assert.deepEqual(geometry.tones,['ample','cached','low','normal','zero']);
    assert.deepEqual(geometry.pro,['PRO','不限','9%']);assert.deepEqual(geometry.limit,[44,18,'dashed']);
    assert.ok(geometry.missing && geometry.boundary);assert.match(geometry.unusual,/30d 40%/);
    assert.equal(geometry.amount,'17px');assert.equal(geometry.meter,4);assert.match(geometry.reset,/天/);
    const trayQuotas = () => panelRun(`Object.fromEntries([...document.querySelectorAll('.alternative')].filter(row => !row.querySelector('.unusual')).map(row =>
      [row.accountName, [...row.querySelectorAll('.chip:not(.unlimited)')].map(chip => [chip.textContent, chip.dataset.tone, getComputedStyle(chip).color])]))`);
    const expected = await trayQuotas();
    for (const layout of ['cards','rows']) {
      const main = await run(`(() => {
        accountLayout='${layout}'; renderWorkbench();
        return Object.fromEntries([...document.querySelectorAll('.account-card')].map(card => [card.dataset.profile,
          [...card.querySelectorAll('.quota-cell')].map(cell => {
            const value = cell.querySelector('.quota-number');
            return [value.textContent, cell.dataset.tone, getComputedStyle(value).color];
          })]));
      })()`);
      for (const [name, quotas] of Object.entries(expected)) assert.deepEqual(main[name], quotas, layout + ': ' + name);
    }
    await run(`selectTab('settings');document.querySelector('[name=showResetTimes][value=false]').click()`);
    await panelUntil("document.querySelector('.period-reset').textContent.includes(':')");
    window.hide(); host.update(); await openPanel();
    assert.deepEqual(await trayQuotas(), expected, 'Hiding the main window must retain per-window colors');
    assert.equal(await panelRun("!!document.querySelector('.identity .cached') && document.querySelector('.period').dataset.tone==='low'"), true);
    assert.deepEqual(await panelRun(`(() => {
      const row = [...choices.children].find(r => r.querySelector('.chip')?.textContent === '<1%');
      const short = group().alternates.find(a => a.name === row.accountName).windows[0];
      const clock = Date.now;
      try {
        Date.now = () => short.resetsAt * 1000;
        updateQuotaClock();
        return [...row.querySelectorAll('.chip')].map(chip => chip.dataset.tone);
      } finally { Date.now = clock; render(); }
    })()`), ['cached','ample']);
    window.showInactive(); await run(`selectTab('codex')`);
    await panelRun("document.querySelector('#codex').focus()");key('End');
    await panelUntil("document.querySelector('#agy').getAttribute('aria-selected')==='true' && document.querySelectorAll('.period').length===2");
    assert.equal(await panelRun("choices.clientHeight===choices.scrollHeight"),true);
    assert.equal(await panelRun("document.querySelector('#current').offsetHeight"),geometry.hero);
    key('Home');await panelUntil("document.querySelector('#codex').getAttribute('aria-selected')==='true'");
    key('Escape');
    for(let i=0;i<40 && panel.isVisible();i++)await pause(25);
    assert.equal(panel.isVisible(),false);
    await openPanel();
    const chosen = snapshot.groups.find(g=>g.id==='codex').alternates.at(-1).name;
    async function chooseLast() {
      await panelRun("document.querySelector('#codex').focus()");
      key('Down');await panelUntil("document.activeElement.matches('.alternative:first-child')");
      key('Up');await panelUntil("document.activeElement.matches('.alternative:last-child') && document.querySelector('#choices').scrollTop>0");
      const previous = await panelRun("document.querySelector('#choices').scrollTop");
      host.update(); await pause(50);
      assert.equal(await panelRun("document.activeElement.matches('.alternative:last-child') && document.querySelector('#choices').scrollTop"),previous);
      const point=await panelRun(`(()=>{const r=document.activeElement.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
      for (const type of ['mouseDown','mouseUp']) panel.webContents.sendInputEvent({type,button:'left',clickCount:1,...point});
    }
    await run(`openAccountDetails('codex','个人主力')`);
    await chooseLast(); await panelUntil("document.querySelector('#switchDetail').textContent.includes('主窗口')");
    assert.equal(await run(`!!document.querySelector('dialog[open]') && !window.testApi.calls().some(c=>c.method==='switch')`), true);
    key('Escape');await panelUntil("document.querySelector('#switchPrompt').hidden");
    await run(`document.querySelector('.account-modal[open]').dismissAccountDialog()`);
    await run(`selectTab('agy')`);
    await chooseLast();
    for (let i=0;i<50 && snapshot.groups[0].current?.name !== chosen;i++) await pause(20);
    assert.equal(snapshot.groups[0].current?.name, chosen);
    assert.deepEqual(await run(`window.testApi.calls().filter(c=>c.method==='switch')`), [{method:'switch',id:'codex',name:chosen}]);
    assert.equal(await run('currentTab'), 'agy', 'A tray switch must preserve the main window platform');
    await until('!switchingAccount');
    for(let i=0;i<80 && panel.isVisible();i++)await pause(25);
    assert.ok(!panel.isVisible());
    await run("accountTestApi.trayConfirmation({token:'test',clients:['Codex'],unmanaged:true,migration:true,interrupted:true})");
    await openPanel();
    const prompt = async () => {
      await panelRun("document.querySelector('#codex').click(); choices.firstElementChild.click()");
      await panelUntil("document.activeElement.id==='confirmSwitch'");
    };
    await prompt();
    assert.match(await panelRun("document.querySelector('#switchPrompt').innerText"),/Codex[\s\S]*中断[\s\S]*尚未保存[\s\S]*私有登录文件[\s\S]*直接切换[\s\S]*保存并切换/);
    key('Escape');await panelUntil("document.activeElement.matches('.alternative') && document.querySelector('#switchPrompt').hidden");
    await prompt();await panelRun("document.querySelector('#agy').click()");
    assert.equal(await panelRun("document.querySelector('#switchPrompt').hidden"), true);
    await prompt();window.focus();
    for(let i=0;i<80 && panel.isVisible();i++)await pause(25);
    assert.ok(!panel.isVisible());
    await openPanel();
    assert.equal(await panelRun("document.querySelector('#switchPrompt').hidden"), true);
    await prompt();key('Enter');
    await panelUntil("document.querySelector('#switchDetail').innerText.includes('请手动打开客户端')");
    assert.ok(panel.isVisible());
    const switches=await run("testApi.calls().filter(c=>c.method==='switch')");
    assert.equal(switches.length,2);
    assert.deepEqual(switches[1].decision,{token:'test',saveUnmanaged:true});
    host.hide();
    await run(`selectTab('codex'); providerTestApi.native(); loadStatus()`);
    await run(`{
      const agent = agentsData.find(a=>a.id==='agy');
      delete agent.active;
      agent.status={available:false,state:'signed-out'};
      for(const p of agent.profiles) {p.isActive=false;p.meta.snapshot.fetchedAt=new Date(0).toISOString();}
      syncTray(true);
    }`);
    window.hide(); await openPanel(); await panelRun("$('agy').click()");
    const ordered = await panelRun("group().alternates.map(p=>p.name)");
    assert.equal(ordered.length,2);
    assert.ok(await panelRun("!group().current && !group().unmanaged && !$('refresh').disabled && group().alternates.every(a=>a.cached)"));
    const before = await run("testApi.calls().filter(c=>c.method==='refresh').length");
    await run(`testApi.blockNextRefresh(${JSON.stringify(ordered[1])})`);
    for (const type of ['keyDown','keyUp']) panel.webContents.sendInputEvent({type,keyCode:'R',modifiers:['meta']});
    await panelUntil("group().bulkRefreshing && $('refresh').getAttribute('aria-busy')==='true' && group().alternates.some(a=>!a.cached)");
    assert.deepEqual(await run(`testApi.calls().filter(c=>c.method==='refresh').slice(${before}).map(c=>[c.id,c.name,c.force])`),
      ordered.map(name=>['agy',name,true]), 'Cmd+R refreshes the viewed platform in list order even with only spare accounts');
    await panelRun("$('codex').click()");
    assert.ok(await panelRun("!$('refresh').disabled && $('refresh').getAttribute('aria-busy')==='false'"));
    host.hide(); await run("testApi.releaseRefresh()");
    await until("!refreshBatches.size && !refreshQueue.jobs.size");
    assert.equal(await run('currentTab'),'codex');
    assert.ok(!window.isVisible() && !panel.isVisible());
    assert.ok(snapshot.groups.find(g=>g.id==='agy').alternates.every(p=>!p.cached));
    await run("accountTestApi.trayConfirmation(undefined);providerTestApi.native();providerTestApi.cli('missing');loadStatus()");
    await openPanel();await panelRun("$('agy').click()");
    assert.deepEqual(await panelRun("[$('refresh').hidden,!!choices.querySelector('.chip'),choices.firstElementChild.textContent]"),[true,false,'Google BPro']);
    await panelRun("choices.firstElementChild.click()");
    await until("!switchingAccount && agentsData[1].active==='Google B'");
    await run(`localStorage.clear()`);
  },
);
