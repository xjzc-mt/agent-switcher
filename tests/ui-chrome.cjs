const outputPath = require('./ui-support.cjs');
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.whenReady().then(async()=>{
  const window=new BrowserWindow({width:880,height:700,show:false,titleBarStyle:'hiddenInset',trafficLightPosition:{x:18,y:18},webPreferences:{preload:path.join(__dirname,'fixture-preload.cjs'),contextIsolation:true,backgroundThrottling:false}});
  const run=s=>window.webContents.executeJavaScript(s);
  const errors=[];window.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
  const capture=async name=>fs.writeFileSync(outputPath(`${name}.png`),(await window.webContents.capturePage()).toPNG());
  try{
    await window.loadFile(path.join(__dirname,'../renderer/index.html'));await pause(200);
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
    await run(`localStorage.clear();accountLayout='cards';applySidebar();renderWorkbench();window.originalCurrentHeight=document.querySelector('.active-session-card').offsetHeight;`);
    await run(`window.testApi.spendingCredits();loadStatus()`);
    for(const collapsed of [false,true])for(const width of (collapsed?[760,880,1120]:[880,1120])){
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
      if(width===880)await capture(`chrome-${collapsed?'collapsed':'expanded'}`);
    }
    await run(`writeLayout('sidebarCollapsed','false');applySidebar();`);window.setSize(880,700);await pause(100);
    assert.equal(await run(`document.querySelector('.current-credit-badge').hasAttribute('data-tooltip')`),false);
    assert.match(await run(`document.querySelector('.current-credit-badge').getAttribute('aria-label')`),/最近检测到余额下降/);
    for(const balance of ['1234567.89','0','-2.35',null]){
      await run(`agentsData[0].status.quota.credits.balance=${JSON.stringify(balance)};renderWorkbench()`);
      assert.equal(await run(`document.querySelector('.active-session-card').offsetHeight===window.originalCurrentHeight`),true);
      assert.equal(await run(`document.querySelector('.current-credit-badge').scrollWidth<=document.querySelector('.current-credit-badge').clientWidth+1`),true);
    }
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
    await run(`localStorage.clear()`);assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:true,sidebarStates:2,currentCreditCases:5,topFeedback:true,modalFeedback:true,noFocusSteal:true,autoDismiss:true,trafficLightClearance:true}));app.exit(0);
  }catch(error){console.error(error);fs.writeFileSync(outputPath('agent-switcher-chrome-error.png'),(await window.webContents.capturePage()).toPNG());app.exit(1);}
});
