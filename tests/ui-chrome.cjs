const outputPath = require('./ui-support.cjs');
const {app,BrowserWindow,ipcMain}=require('electron');
const {EventEmitter}=require('node:events');
const {createTrayPanel}=require('../dist/tray-menu.js');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.whenReady().then(async()=>{
  const window=new BrowserWindow({width:880,height:700,show:false,titleBarStyle:'hiddenInset',trafficLightPosition:{x:18,y:18},webPreferences:{preload:path.join(__dirname,'fixture-preload.cjs'),contextIsolation:true,backgroundThrottling:false,additionalArguments:['--test-tray-menu']}});
  const tray = new EventEmitter();
  tray.setIgnoreDoubleClickEvents = () => {};
  tray.getBounds = () => ({ x:320, y:0, width:20, height:24 });
  let snapshot;
  const host = createTrayPanel(tray, () => snapshot, command => window.webContents.send('tray-command', command));
  ipcMain.on('fixture-tray-state', (_event, next) => { snapshot = next; host.update(); });
  const run=s=>window.webContents.executeJavaScript(s);
  const errors=[];window.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
  const capture=async name=>fs.writeFileSync(outputPath(`${name}.png`),(await window.webContents.capturePage()).toPNG());
  try{
    await window.loadFile(path.join(__dirname,'../renderer/index.html'));await pause(200);
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
      for(let i=0;i<3;i++) window.accountTestApi.alias('团队账号','团队联合测试账号'.repeat(4)+i); loadStatus()`);
    let panel;
    const panelRun = code => panel.webContents.executeJavaScript(code);
    async function pointAt(selector) {
      const point = await panelRun(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el.parentElement.id === 'choices') el.parentElement.scrollTop = el.offsetTop - el.parentElement.offsetTop;
        const r = el.getBoundingClientRect();
        return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)};
      })()`);
      panel.webContents.sendInputEvent({type:'mouseMove', ...point});
      return point;
    }
    async function hoverSwitch() {
      if (!panel?.isVisible()) tray.emit('click', {}, tray.getBounds());
      for (let i=0; i<80; i++) {
        panel = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/tray.html'));
        if (panel?.isVisible() && await panelRun('!!document.querySelector(".nickname")')) break;
        await pause(25);
      }
      assert.ok(panel?.isVisible(), 'Tray panel did not open');
      await pointAt('#switch');
      for (let i=0; i<40 && !await panelRun('!!document.querySelector(".alternative")?.offsetHeight');i++) await pause(25);
      assert.ok(await panelRun('document.querySelector("#content").offsetHeight && document.querySelector("#choices").offsetHeight'), 'Hover should keep the account overview visible');
      for (let i=0; i<40 && !await panelRun('innerHeight >= Math.ceil(document.querySelector("#panel").getBoundingClientRect().height)');i++) await pause(25);
      assert.ok(await panelRun('innerHeight >= document.querySelector("#choices").getBoundingClientRect().bottom && scrollY === 0'), 'The native window must expose the expanded list');
    }
    await hoverSwitch();
    const choices = await panelRun('Array.from(document.querySelectorAll(".alternative"), el=>el.textContent)');
    assert.equal(choices.length,7); assert.match(choices[0],/82%/);
    assert.doesNotMatch(choices.join(' '), /@example\.test/);
    const narrow = await panelRun(`(() => {
      const row = [...document.querySelectorAll('.alternative')].find(el=>el.textContent.includes('团队联合测试账号'));
      const name = row.querySelector('.alt-name'), quota = row.querySelector('.alt-detail');
      return {width:innerWidth, scroll:document.documentElement.scrollWidth, clipped:name.scrollWidth>name.clientWidth && name.clientWidth>0,
        quotaVisible:quota.scrollWidth<=quota.clientWidth && quota.getBoundingClientRect().right<=innerWidth, quota:quota.textContent};
    })()`);
    assert.deepEqual(narrow, {width:260,scroll:260,clipped:true,quotaVisible:true,quota:'5h 10% · 7d 40%'});
    const chosen = snapshot.groups.find(g=>g.id==='codex').alternates.at(-1).name;
    async function chooseLast() {
      const point = await pointAt('.alternative:last-of-type');
      await pause(150);
      assert.ok(await panelRun('document.querySelector(".alternative:last-of-type").matches(":hover")'), 'Moving into the list must keep it open');
      const previous = await panelRun('document.querySelector(".alternative:last-of-type").focus(); document.querySelector("#choices").scrollTop');
      assert.ok(previous > 0, 'The last profile should be below the scroll fold');
      host.update();
      await pause(50);
      assert.equal(await panelRun('document.activeElement.matches(".alternative:last-of-type") && document.querySelector("#choices").scrollTop'), previous);
      panel.webContents.sendInputEvent({type:'mouseDown', button:'left', clickCount:1, ...point});
      panel.webContents.sendInputEvent({type:'mouseUp', button:'left', clickCount:1, ...point});
    }
    await run(`openAccountDetails('codex','个人主力')`);
    await chooseLast();
    assert.equal(await run(`!!document.querySelector('dialog[open]') && !window.testApi.calls().some(c=>c.method==='switch')`), true);
    await run(`document.querySelector('.account-modal[open]').dismissAccountDialog()`);
    await run(`selectTab('agy')`);
    await hoverSwitch(); await chooseLast();
    for (let i=0;i<50 && snapshot.groups[0].current?.name !== chosen;i++) await pause(20);
    assert.equal(snapshot.groups[0].current?.name, chosen);
    assert.deepEqual(await run(`window.testApi.calls().filter(c=>c.method==='switch')`), [{method:'switch',id:'codex',name:chosen}]);
    assert.equal(await run('currentTab'), 'agy', 'A tray switch must preserve the main window platform');
    await run(`localStorage.clear()`);assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:true,sidebarStates:2,longCreditFits:true,topFeedback:true,modalFeedback:true,noFocusSteal:true,autoDismiss:true,trafficLightClearance:true}));app.exit(0);
  }catch(error){console.error(error);fs.writeFileSync(outputPath('agent-switcher-chrome-error.png'),(await window.webContents.capturePage()).toPNG());app.exit(1);}
});
