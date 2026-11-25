const suite = require('./ui-support.cjs');
const assert = require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createTrayPanel}=require('../dist/tray-menu.js');
const { BrowserWindow, ipcMain } = require('electron');

module.exports = suite(
  { width: 880, height: 700, titleBarStyle: 'hiddenInset', trafficLightPosition: {x: 18, y: 18}, additionalArguments: ['--test-tray-menu'] },
  async ({ window, run, load, pause, capture }) => {
    const tray = new EventEmitter();
    tray.setIgnoreDoubleClickEvents = () => {};
    tray.getBounds = () => ({ x:320, y:0, width:20, height:24 });
    let snapshot;
    const host = createTrayPanel(tray, () => snapshot, command => window.webContents.send('tray-command', command));
    const onSnapshot = (_event, next) => { snapshot = next; host.update(); };
    ipcMain.on('fixture-tray-state', onSnapshot);
    window.once('closed', () => ipcMain.off('fixture-tray-state', onSnapshot));

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
    assert.equal(await run(`document.querySelector('#toastBox').parentElement===document.body&&document.querySelector('#toastBox').matches(':popover-open')`),true,'Closing details must preserve its pending feedback');
    await run(`document.querySelector('.toast-close').click()`);await pause(180);assert.equal(await run(`document.querySelector('#toastBox').matches(':popover-open')`),false);
    await run(`showToast('连接失败，请稍后再试','error')`);assert.equal(await run(`document.querySelector('.toast-item').getAttribute('role')`),'alert');
    await run(`document.querySelector('.toast-close').click()`);await pause(180);
    await run(`window.providerTestApi.native(); window.accountTestApi.alias('个人主力','私人-demo@example.test');
      for(let i=0;i<16;i++) window.accountTestApi.alias('团队账号','团队联合测试账号'.repeat(4)+i); loadStatus()`);
    await run(`{
      const a=agentsData[0], sign=a.profiles[1].meta.snapshot=structuredClone(a.profiles[1].meta.snapshot);
      a.status=structuredClone(a.status);
      for(const status of [a.status,sign]) {status.plan='pro';delete status.quota.primaryWindow;status.quota.secondaryWindow.usedPercent=91;}
      const statuses=a.profiles.slice(2,7).map(p=>p.meta.snapshot=structuredClone(p.meta.snapshot));
      [0,13,91,100].forEach((used,i)=>statuses[i].quota.primaryWindow.usedPercent=used);
      delete statuses[0].quota.secondaryWindow;
      statuses[2].fetchedAt=new Date(0).toISOString();statuses[4].quota.secondaryWindow.windowMins=43200;
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
      assert.fail('Panel did not reach ' + expression);
    }
    async function openPanel() {
      if (!panel?.isVisible()) tray.emit('click', {}, tray.getBounds());
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
    assert.equal(geometry.count,20);assert.equal(geometry.height,312);assert.equal(geometry.width,260);assert.equal(geometry.visibleRows,5.5);
    assert.ok(geometry.aligned && geometry.chipSize && geometry.nameClipped && geometry.private);
    assert.deepEqual(geometry.tones,['ample','cached','empty','low','normal']);
    assert.deepEqual(geometry.pro,['PRO','不限','9%']);assert.deepEqual(geometry.limit,[44,18,'dashed']);
    assert.ok(geometry.missing && geometry.boundary);assert.match(geometry.unusual,/30d 40%/);
    assert.equal(geometry.amount,'17px');assert.equal(geometry.meter,4);assert.match(geometry.reset,/天/);
    await run(`selectTab('settings');document.querySelector('[name=showResetTimes][value=false]').click()`);
    await panelUntil("document.querySelector('.period-reset').textContent.includes(':')");
    snapshot.windowClosed=true;host.update();
    await panelUntil("!!document.querySelector('.identity .cached') && !document.querySelector('[data-tone]:not([data-tone=cached])')");
    delete snapshot.windowClosed;host.update();await run(`selectTab('codex')`);
    await panelRun("document.querySelector('#codex').focus()");key('End');
    await panelUntil("document.querySelector('#agy').getAttribute('aria-selected')==='true' && document.querySelectorAll('.period').length===2");
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
    await chooseLast(); await pause(50);
    assert.equal(await run(`!!document.querySelector('dialog[open]') && !window.testApi.calls().some(c=>c.method==='switch')`), true);
    await run(`document.querySelector('.account-modal[open]').dismissAccountDialog()`);
    await run(`selectTab('agy')`);
    await chooseLast();
    for (let i=0;i<50 && snapshot.groups[0].current?.name !== chosen;i++) await pause(20);
    assert.equal(snapshot.groups[0].current?.name, chosen);
    assert.deepEqual(await run(`window.testApi.calls().filter(c=>c.method==='switch')`), [{method:'switch',id:'codex',name:chosen}]);
    assert.equal(await run('currentTab'), 'agy', 'A tray switch must preserve the main window platform');
    await run(`localStorage.clear()`);
  },
);
