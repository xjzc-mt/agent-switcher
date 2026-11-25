const suite = require('./ui-support.cjs');
const assert = require('node:assert/strict');
const {defaultWidth,minimumWidth,updateWindowSidebarLayout}=require('../dist/window-layout');
const { ipcMain } = require('electron');

module.exports = suite(
  { width: defaultWidth, height: 700, minWidth: minimumWidth(152), minHeight: 620, titleBarStyle: 'hiddenInset', additionalArguments: ['--test-window-layout'] },
  async ({ window, run, load, pause, until, capture }) => {
    window.once('closed', () => ipcMain.removeHandler('test-window-layout'));
    ipcMain.handle('test-window-layout',(event,collapsed,width)=>{
      assert.equal(event.sender,window.webContents);
      return updateWindowSidebarLayout(window,collapsed,width);
    });
    const rightClick=selector=>run(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}))`);
    const click=async(selector,edge=false)=>{
      const point=await run(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});element.scrollIntoView({block:'nearest'});const r=element.getBoundingClientRect(),x=Math.round(r.x+(${edge}?2:r.width/2)),y=Math.round(r.y+r.height/2);return {x,y,hit:element.contains(document.elementFromPoint(x,y))};})()`);
      assert.equal(point.hit,true,`${selector} must receive pointer hits`);
      const {x,y}=point;
      window.webContents.sendInputEvent({type:'mouseMove',x,y});
      window.webContents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});
      window.webContents.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1});
    };
    const close=()=>run(`{const dialog=document.querySelector('.account-modal[open]');dialog.querySelector('[data-close-dialog]').click();dialog.dismissAccountDialog();}`);
    const minimum=async width=>{for(let i=0;i<100;i++){if(window.getMinimumSize()[0]===width)return;await pause(20);}throw new Error(`Window minimum did not become ${width}`);};
    const checkDrag=async(enabled=true)=>{
      const state=await run(`(()=>{
        const header=document.querySelector('.workspace-topbar'),h=header.getBoundingClientRect();
        const overlaps=[...document.querySelectorAll('body *')].filter(e=>{
          if(header.contains(e)||e.contains(header)||getComputedStyle(e).getPropertyValue('-webkit-app-region')!=='no-drag')return false;
          const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.left<h.right&&r.right>h.left&&r.top<h.bottom&&r.bottom>h.top;
        }).map(e=>e.tagName+'.'+(e.getAttribute('class')||''));
        return {region:getComputedStyle(header).getPropertyValue('-webkit-app-region'),top:h.top,height:h.height,overlaps};
      })()`);
      assert.equal(state.region,enabled?'drag':'no-drag');assert.equal(state.top,0);assert.equal(state.height,52);
      if(enabled)assert.deepEqual(state.overlaps,[],'Clipped content must not subtract native titlebar drag regions');
    };
    const threeCards=async()=>{
      const cards=await run(`[...document.querySelectorAll('.accounts-grid .account-card')].map(card=>{const r=card.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,right:r.right};})`);
      assert.equal(cards.length,3,'The fixture must expose three backup cards');
      cards.forEach((card,index)=>{
        assert.ok(Math.abs(card.width-180)<0.5,'Native minimum must retain minimum-width cards');
        assert.ok(Math.abs(card.y-cards[0].y)<0.5,'All three cards must remain on one row');
        if(index)assert.ok(Math.abs(card.x-cards[index-1].right-8)<0.5,'Card gaps must stay visible');
      });
    };

    await load();
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
    await run(`localStorage.clear();accountLayout='cards';applySidebar();renderWorkbench()`);await minimum(748);
    const initialCalls=await run(`window.testApi.calls().length`);
    assert.deepEqual(window.getSize(),[840,700],'The default native window must be 840 × 700');
    for(const collapsed of [false,true]){
      await run(`writeLayout('sidebarCollapsed','${collapsed}');applySidebar()`);await minimum(collapsed?636:748);await pause(80);
      const geometry=await run(`(()=>{const grid=document.querySelector('.accounts-grid'),pool=document.querySelector('.account-section').getBoundingClientRect(),r=grid.getBoundingClientRect(),cards=[...grid.querySelectorAll('.account-card')].map(card=>{const c=card.getBoundingClientRect();return {width:c.width,y:c.y};});return {columns:getComputedStyle(grid).gridTemplateColumns.split(' ').map(Number.parseFloat),cards,remaining:pool.right-r.right,overflow:document.documentElement.scrollWidth>innerWidth};})()`);
      const count=collapsed?4:3,width=collapsed?180:208;
      assert.equal(geometry.columns.length,count,JSON.stringify(geometry));
      assert.ok(geometry.columns.every(column=>Math.abs(column-width)<0.5),JSON.stringify(geometry));
      assert.equal(geometry.cards.length,3,'Default geometry must use the existing backup fixture');
      assert.ok(geometry.cards.every(card=>Math.abs(card.width-width)<0.5&&Math.abs(card.y-geometry.cards[0].y)<0.5),JSON.stringify(geometry));
      assert.ok(Math.abs(geometry.remaining-(collapsed?0:8))<0.5,JSON.stringify(geometry));assert.equal(geometry.overflow,false);
      assert.deepEqual(window.getSize(),[840,700],'Sidebar changes must retain the default window size');
      await capture(`accounts-default-${collapsed?'collapsed':'expanded'}.png`);
    }
    assert.equal(await run(`window.testApi.calls().length`),initialCalls,'Default layout checks must not operate on accounts');
    await run(`writeLayout('sidebarCollapsed','false');applySidebar()`);await minimum(748);
    await run(`document.querySelectorAll('.account-main-name,.account-name,.account-email-sub,.session-account-email,.credit-edge').forEach(element=>element.click())`);
    assert.equal(await run(`document.querySelector('dialog[open]')===null`),true);
    assert.equal(await run(`document.querySelectorAll('[data-account-context] [data-edit-account-name],[data-account-context] [data-action=openAccountDetails]').length`),0);

    // Check native minimums and state preservation; detailed geometry stays in ui-layout.
    await run(`window.cardBeforeResize=document.querySelector('.account-card');window.currentBeforeResize=document.querySelector('.active-session-card');`);
    for (const collapsed of [false, true]) {
      await run(`writeLayout('sidebarCollapsed','${collapsed}');applySidebar()`);
      const smallest=collapsed?636:748;
      await minimum(smallest);
      for (const width of [1440, smallest]) {
        window.setSize(width, 740);
        await pause(80);
        assert.equal(await run(`window.cardBeforeResize===document.querySelector('.account-card')&&window.currentBeforeResize===document.querySelector('.active-session-card')`), true, 'Resizing must preserve account DOM');
        if(width===smallest){assert.equal(window.getSize()[0],smallest);await threeCards();}
      }
    }
    assert.equal(await run(`window.testApi.calls().length`), initialCalls, 'Size changes must not query accounts');
    // Reopening from the narrow-padding breakpoint must preserve three cards.
    assert.equal(window.getSize()[0],636);
    await click('#sidebarToggle');await minimum(748);assert.ok(window.getSize()[0]>=748);
    await run(`writeLayout('sidebarWidth',144);applySidebar()`);await minimum(740);
    window.setSize(740,740);await pause(80);assert.equal(window.getSize()[0],740);await threeCards();
    await run(`writeLayout('sidebarWidth',184);applySidebar()`);await minimum(780);assert.ok(window.getSize()[0]>=780);
    await pause(80);await threeCards();
    await click('#sidebarToggle');await minimum(636);
    window.setSize(636,740);await pause(80);assert.equal(window.getSize()[0],636);await threeCards();
    await click('#sidebarToggle');await minimum(780);assert.ok(window.getSize()[0]>=780);
    await pause(80);await threeCards();
    await run(`writeLayout('sidebarWidth',152);applySidebar()`);await minimum(748);window.setSize(880,740);await pause(80);
    assert.equal(await run(`getComputedStyle(document.querySelector('.workspace-topbar')).getPropertyValue('-webkit-app-region')`),'drag');
    for(const selector of ['#sidebarToggle','.topbar-actions'])assert.equal(await run(`getComputedStyle(document.querySelector('${selector}')).getPropertyValue('-webkit-app-region')`),'no-drag');
    for(let i=0;i<2;i++){
      await click('#sidebarToggle');await minimum(i%2===0?636:748);
      assert.equal(await run(`(()=>{const button=document.querySelector('#sidebarToggle'),header=button.closest('.workspace-topbar'),r=button.getBoundingClientRect(),h=header?.getBoundingClientRect();return header?.parentElement===document.body&&r.x>=h.x&&r.right<=h.right&&r.y>=h.y&&r.bottom<=h.bottom;})()`),true,'Toggle must stay inside its own draggable header, in both states');
      assert.equal(await run(`document.querySelector('#sidebarToggle').getAttribute('aria-expanded')`),String(i%2!==0));
    }
    // Collapsed state persists across reloads.
    await click('#sidebarToggle');await minimum(636);
    window.webContents.reload();await pause(300);
    assert.equal(await run(`document.querySelector('#sidebarToggle').getAttribute('aria-expanded')`),'false','Reload must restore the collapsed state');
    await click('#sidebarToggle');await minimum(748);
    // Check the regions of long scrolling content, not just the header's CSS declaration.
    await run(`window.providerTestApi.native();loadStatus()`);
    await run(`window.beforeScrollAgents=structuredClone(agentsData)`);
    for(const [id,layout,collapsed] of [['codex','cards',false],['agy','rows',true]]){
      await run(`{const a=agentsData.find(a=>a.id==='${id}'),base=a.profiles[1];a.profiles=[a.profiles[0],...Array.from({length:25},(_,i)=>({...structuredClone(base),name:'滚动账号'+i,isActive:false}))];}`);
      await run(`writeLayout('sidebarCollapsed','${collapsed}');applySidebar();selectTab('${id}');accountLayout='${layout}';renderWorkbench()`);
      await minimum(collapsed?636:748);
      await run(`$('workspaceContent').scrollTop=100000`);await pause(40);
      assert.ok(await run(`$('workspaceContent').scrollTop>0`));
      await checkDrag();
      await click('#sidebarToggle');await minimum(collapsed?748:636);await checkDrag();
    }
    window.setSize(880,620);await pause(60);
    await run(`window.appUpdateTestApi.setState({status:'available',release:{version:'1.1.0',downloadable:true,notes:'更新说明\\n'.repeat(40)}});selectTab('settings')`);
    await until(`!!document.querySelector('[data-update-action="notes"]:not([hidden])')`);
    await click('[data-update-action="notes"]');
    await until(`!$('appUpdateNotes').hidden`);
    await run(`$('workspaceContent').scrollTop=100000`);await checkDrag();
    assert.ok(await run(`$('workspaceContent').scrollTop>0`),'Expanded update notes must exercise settings scrolling');
    await run(`agentsData=window.beforeScrollAgents;delete window.beforeScrollAgents;selectTab('codex')`);
    await run(`openSaveModal('codex');selectAddTab('session')`);await checkDrag(false);
    await run(`closeSaveModal()`);await checkDrag();
    await run(`void askPassword()`);await checkDrag(false);
    await run(`document.querySelector('dialog[open] [data-cancel]').click()`);await checkDrag();
    window.setSize(880,740);
    // Quota-capable cards share selection handlers. The legacy view renders its own checkbox.
    await run(`selectTab('codex');accountLayout='rows';startSelection()`);
    const card = '.account-card[data-profile="工作账号"]';
    const operations = await run(`window.testApi.calls().length`);
    await click(card + ' .quota-number');await until(`exportSelection.size===1`);
    await click(card + ' .account-select');await until(`exportSelection.size===0`);
    window.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});
    window.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});
    await until(`exportSelection.size===1`);
    await click(card,true);await until(`exportSelection.size===0`);
    await run(`endSelection()`);
    assert.equal(await run(`window.testApi.calls().length`),operations);
    await run(`window.providerTestApi.setup();loadStatus()`);
    await run(`selectTab('agy');startSelection()`);
    await click('.credential-card .account-main-name');
    await until(`document.querySelector('.credential-card .account-select').checked`);
    await run(`endSelection()`);
    await run(`selectTab('codex');setAccountLayout('rows')`);

    const row='[data-profile="工作账号"].account-card';
    await run(`document.querySelector('${row}').focus()`);await rightClick(row);
    assert.equal(await run(`document.querySelectorAll('.account-modal[open]').length`),1);
    await checkDrag(false);
    await pause(170);
    const closeStyle=await run(`(()=>{const button=document.querySelector('[data-close-dialog]'),r=button.getBoundingClientRect(),icon=button.querySelector('svg').getBoundingClientRect();return {width:r.width,height:r.height,x:r.x+r.width/2,y:r.y+r.height/2,centered:Math.abs(icon.x+icon.width/2-r.x-r.width/2)<1&&Math.abs(icon.y+icon.height/2-r.y-r.height/2)<1,label:button.getAttribute('aria-label')};})()`);
    assert.equal(closeStyle.width,26);assert.equal(closeStyle.height,26);assert.equal(closeStyle.centered,true);assert.equal(closeStyle.label,'关闭');
    window.webContents.sendInputEvent({type:'mouseMove',x:Math.round(closeStyle.x),y:Math.round(closeStyle.y)});await pause(170);
    assert.equal(await run(`getComputedStyle(document.querySelector('[data-close-dialog]')).borderTopColor`),'rgba(0, 0, 0, 0)');
    await capture('account-detail-close-hover.png');
    await run(`document.querySelector('.account-modal [data-close-dialog]').click()`);
    assert.equal(await run(`document.querySelector('.account-modal').hasAttribute('data-closing')`),true);
    await until(`!document.querySelector('.account-modal')`);
    await checkDrag();
    assert.equal(await run(`document.activeElement.closest('[data-account-context]')===null`),true);
    assert.equal(await run(`document.querySelector('${row}').matches(':focus-within,.is-selected')`),false);

    await rightClick(row);
    await run(`document.querySelector('.account-modal[open]').dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:1,clientY:1}))`);
    await until(`!document.querySelector('.account-modal')`);
    assert.equal(await run(`document.activeElement.closest('[data-account-context]')===null`),true);
    await rightClick(row);
    window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await until(`!document.querySelector('.account-modal')`);
    assert.equal(await run(`document.activeElement.closest('[data-account-context]')===null`),true);
    await run(`document.querySelector('${row}').focus()`);
    window.webContents.sendInputEvent({type:'keyDown',keyCode:'F10',modifiers:['shift']});
    window.webContents.sendInputEvent({type:'keyUp',keyCode:'F10',modifiers:['shift']});
    await until(`!!document.querySelector('.account-modal[open]')`);
    await run(`document.querySelector('[data-close-dialog]').focus()`);
    assert.equal(await run(`getComputedStyle(document.activeElement).outlineStyle`),'solid','The close button keeps visible keyboard focus');
    await close();
    assert.equal(await run(`document.activeElement===document.querySelector('${row}')`),true);
    assert.equal(await run(`getComputedStyle(document.activeElement).outlineStyle`),'solid');
    assert.equal(await run(`document.activeElement.hasAttribute('data-keyboard-focus')`),true);
    await run(`document.querySelector('#accountSearch').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));document.querySelector('#accountSearch').focus()`);
    assert.equal(await run(`document.querySelector('[data-keyboard-focus]')===null`),true);
    await run(`document.querySelector('${row}').focus()`);
    await run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Enter'}))`);
    assert.equal(await run(`document.querySelector('dialog[data-account-details]').dataset.profile`),'工作账号');await close();
    // Opening and closing rapidly does not leave an invisible modal intercepting clicks.
    for(let i=0;i<3;i++){await rightClick(row);await close();}
    assert.equal(await run(`document.querySelector('.account-modal')===null`),true);
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await rightClick(row);
    assert.equal(await run(`getComputedStyle(document.querySelector('.account-modal')).animationName`),'none');
    await close();window.webContents.debugger.detach();
    await run(`localStorage.clear()`);
  },
);
