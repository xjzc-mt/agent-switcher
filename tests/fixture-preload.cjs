const { contextBridge, ipcRenderer } = require('electron');
const now = new Date().toISOString();
function snapshot(email, used, weekly) {
  return { available:true, account:email, plan:'plus', state:'ok', checkedAt:now, fetchedAt:now, quota:{ primaryWindow:{usedPercent:used,windowMins:300,resetsAt:Math.floor(Date.now()/1000)+7200}, secondaryWindow:{usedPercent:weekly,windowMins:10080,resetsAt:Math.floor(Date.now()/1000)+360000} } };
}
const names = ['个人主力', '工作账号', '团队账号', '备用账号'];
const profiles = names.map((name,i)=>({name,isActive:i===0,meta:{email:`account-${i+1}@example.test`,savedAt:now,snapshot:snapshot(`account-${i+1}@example.test`,[18,67,90,45][i],[35,52,60,21][i])}}));
profiles[0].meta.snapshot.quota.credits={balance:'12.5'};
profiles[1].meta.snapshot.quota.credits={balance:'4.2'};
const data = [{id:'codex',label:'Codex',active:names[0],status:profiles[0].meta.snapshot,profiles}, {id:'claude',label:'Claude Code',status:{available:false,state:'unsupported',extra:'macOS Keychain 登录和额度查询暂不支持'},profiles:[],switchUnsupported:'Keychain 暂不支持'}, {id:'agy',label:'Antigravity',status:{available:false,state:'unsupported',extra:'仅管理文件凭据；切换后请重启 Antigravity'},profiles:[]}];
let settings = { showResetTimes: true, openPrivateLogin:true };
let failNextSettings = false;
contextBridge.exposeInMainWorld('settingsTestApi', { failNext: () => { failNextSettings = true; } });
const calls = [];
let appUpdateState = { currentVersion: '1.0.0', status: 'idle', autoCheck: true };
let appUpdateFailure;
const appUpdateListeners = new Set();
function setAppUpdateState(value) {
  appUpdateState = { ...appUpdateState, ...value };
  for (const listener of appUpdateListeners) listener(appUpdateState);
  return appUpdateState;
}
function recordAppUpdate(method, value) {
  calls.push({ method: `update-${method}`, value });
  if (appUpdateFailure) { const message = appUpdateFailure; appUpdateFailure = undefined; throw new Error(message); }
  return value ? setAppUpdateState(value) : { ok: true };
}
contextBridge.exposeInMainWorld('appUpdateTestApi', {
  setState: setAppUpdateState,
  failNext: message => { appUpdateFailure = message; },
  listenerCount: () => appUpdateListeners.size,
});
let browserLogin, loginSequence = 0;
let blockNextSave=false, releaseSave;
contextBridge.exposeInMainWorld('loginTestApi', {
 complete(email) { browserLogin = {...browserLogin, ready:true, account:email, email}; },
 expire(name) { const p=data[0].profiles.find(p=>p.name===name);p.meta.snapshot={...p.meta.snapshot,state:'expired',authExpired:true}; },
 blockSave() { blockNextSave=true; },
 releaseSave() { releaseSave?.(); },
});
let importMode = 'plain';
const importItems = [{key:'codex/import-A',agent:'codex',profile:'import-A',email:'import-a@example.test'},{key:'codex/import-B',agent:'codex',profile:'import-B',email:'import-b@example.test'}];
let credentialBatch,credentialPreviewId=0;
let blockNextRefresh = false, releaseRefresh, failNextRefresh = false, nextRefreshCredit;
let refreshBarrier, releaseRefreshBarrier;
let reuseNextRefresh = false;
let blockNextRename=false,releaseRename;
let pendingCredentialUpdate;
let failNextDelete=false,blockNextDelete=false,releaseDelete;
let failNextDeletePreview=false,blockNextDeletePreview=false,releaseDeletePreview,logoutUnsupported;
const deletionPreviews=new Map(),fixtureAliases=new Map();
let deletePreviewId=0;
contextBridge.exposeInMainWorld('providerTestApi', {
  native:()=>{
    const make=(email,plan)=>({available:true,account:email,plan,state:'ok',checkedAt:now,fetchedAt:now,quota:{buckets:
      ['Gemini','Claude / GPT','Gemini 4 Argon'].map((label,i)=>({id:label,label,windows:(i===2?[10080]:[300,10080]).map(windowMins=>({windowMins,usedPercent:i===1?51:0,resetsAt:Math.floor(Date.now()/1000)+7200}))}))}});
    data[2].management={quota:true,storage:'keychain',canSaveCurrent:true,isolatedLogin:true};
    delete data[2].switchUnsupported;
    data[2].profiles=['Google A','Google B'].map((name,i)=>({name,isActive:!i,meta:{email:`google-${i}@example.test`,snapshot:make(`google-${i}@example.test`,i?'Google AI Pro':'Google AI Ultra')}}));
    data[2].active='Google A';data[2].status=data[2].profiles[0].meta.snapshot;
  },
  setup:()=>{
    data[1].management={quota:false,storage:'keychain',canSaveCurrent:false,notice:'登录由 Claude Code 管理，已保存的文件凭据可导入、导出；暂不支持 Keychain 账号切换。',loginLabel:'在 Claude Code 登录',loginHint:'运行官方 auth login，会改变当前配置目录的登录账号。'};
    data[1].status={available:true,state:'ok',account:'current@example.test',plan:'pro'};
    data[1].profiles=['个人','开发','团队备份'].map((name,i)=>({name,meta:{email:`claude-${i+1}@example.test`,snapshot:{available:true,state:'unverified',plan:i===1?'max':i===0?'pro':undefined}}}));
    data[2].management={quota:false,storage:'unified',canSaveCurrent:false,notice:'Antigravity 2.x 已统一 App、CLI 与 IDE 登录。旧版凭据仅作备份，请在官方客户端切换账号。',loginLabel:'打开 Antigravity',loginHint:'在官方客户端中查看或更改登录账号。'};
    data[2].switchUnsupported='共用认证暂不支持文件切换';
    data[2].profiles=[{name:'旧版账号备份',meta:{email:'google@example.test',snapshot:{available:true,state:'unverified'}}}];
  },
});
contextBridge.exposeInMainWorld('accountTestApi',{
  proTiers:()=>{['promax','prolite','pro','promax'].forEach((plan,i)=>profiles[i].meta.snapshot.plan=plan);},
  failDelete:()=>{failNextDelete=true;},
  blockDelete:()=>{blockNextDelete=true;},
  releaseDelete:()=>releaseDelete?.(),
  failDeletePreview:()=>{failNextDeletePreview=true;},
  blockDeletePreview:()=>{blockNextDeletePreview=true;},
  releaseDeletePreview:()=>releaseDeletePreview?.(),
  logoutUnsupported:reason=>{logoutUnsupported=reason;},
  alias:(name,alias)=>{const p=data[0].profiles.find(p=>p.name===name);fixtureAliases.set(alias,name);data[0].profiles.push({...p,name:alias,isActive:false,meta:{...p.meta}});},
});
contextBridge.exposeInMainWorld('nameTestApi',{
  blockNext:()=>{blockNextRename=true;},
  release:()=>releaseRename?.(),
});
let statusReads = 0;
contextBridge.exposeInMainWorld('refreshTestApi', {
  blockAll:()=>{refreshBarrier=new Promise(resolve=>{releaseRefreshBarrier=resolve;});},
  releaseAll:()=>{refreshBarrier=undefined;releaseRefreshBarrier?.();releaseRefreshBarrier=undefined;},
  reuseNext:()=>{reuseNextRefresh=true;},
  statusReads:()=>statusReads,
  expireAll:()=>{for(const p of data[0].profiles)p.meta.snapshot.checkedAt=new Date(Date.now()-600000).toISOString();data[0].status.checkedAt=new Date(Date.now()-600000).toISOString();},
  ageSnapshots:()=>{for(const p of data[0].profiles){p.meta.snapshot.fetchedAt=new Date(Date.now()-600000).toISOString();p.meta.snapshot.checkedAt=p.meta.snapshot.fetchedAt;}},
  failNext:()=>{failNextRefresh=true;},
  nextCredit:balance=>{nextRefreshCredit=balance;},
});
contextBridge.exposeInMainWorld('testApi', {calls:()=>calls, clearInjection:()=>{profiles[2].meta.snapshot.plan='plus';}, setImportMode:value=>{importMode=value;}, blockNextRefresh:()=>{blockNextRefresh=true;}, releaseRefresh:()=>releaseRefresh?.(), spendingCredits:()=>{ const activity={lastDecreaseAt:new Date().toISOString(),previousBalance:'12.5',currentBalance:'11.5'}; profiles[0].meta.snapshot.creditActivity=activity; profiles[0].meta.snapshot.quota.credits.balance='11.5'; profiles[1].meta.snapshot.creditActivity={...activity,previousBalance:'4.2',currentBalance:'3.2'}; profiles[1].meta.snapshot.quota.credits.balance='3.2'; }, rename:()=>{data[0].profiles[2].name="O'Reilly & <team>";}, inject:()=>{data[0].profiles[2].meta.snapshot.plan='<img src=x onerror="window.injected=true">';}});
contextBridge.exposeInMainWorld('api', {
 setSidebarLayout:async(collapsed,width)=>process.argv.includes('--test-window-layout')?ipcRenderer.invoke('test-window-layout',collapsed,width):contextBridge.executeInMainWorld({func:sidebarWidth=>({minWidth:AccountLayout.minimumWidth(sidebarWidth),minHeight:620}),args:[collapsed?56:width]}),
 getStatus:async()=>{statusReads++; return data.map(a=>({...a,refreshAt:a.id==='codex'?Date.parse(a.status.checkedAt||now)+60000:Infinity,profiles:a.profiles.map(p=>({...p,refreshAt:Date.parse(p.meta.snapshot?.checkedAt||now)+300000}))}));},
 getSettings:async()=>settings,
 saveSettings:async(value)=>{
   if(failNextSettings){failNextSettings=false;throw new Error('模拟设置保存失败');}
   settings=value; calls.push({method:'settings',value}); return settings;
 },
 copyCleanupPrompt:async()=>{calls.push({method:'copy-cleanup'});return {ok:true};},
 getAppUpdateState: async () => appUpdateState,
 onAppUpdateState: callback => { appUpdateListeners.add(callback); return () => appUpdateListeners.delete(callback); },
 checkAppUpdates: async () => recordAppUpdate('check', { status: 'unavailable', message: '暂未取得可用版本', lastCheckedAt: Date.now() }),
 downloadAppUpdate: async () => recordAppUpdate('download', { status: 'downloading', progress: 0, message: '' }),
 cancelAppUpdate: async () => recordAppUpdate('cancel', { status: 'available', progress: undefined }),
 openAppUpdate: async () => recordAppUpdate('open'),
 setAutoUpdateCheck: async enabled => recordAppUpdate('auto', { autoCheck: enabled }),
 quitForAppUpdate: async () => recordAppUpdate('quit'),
 openProjectPage: async () => recordAppUpdate('project'),
 previewImport:async(kind,agent)=>{
   calls.push({method:'preview-import',kind,agent});
   if(importMode==='canceled')return {canceled:true};
   if(kind==='credentials'){
     const initial=importItems.map((item,i)=>({...item,profile:['个人备用','工作备用'][i],state:'ready',fileName:'账号合集.json',sourceIndex:i+1}));
     if(importMode==='batch'||importMode==='batch-update')initial.push({key:'duplicate',agent:'codex',profile:'duplicate',email:'saved@example.test',fileName:'账号合集.json',sourceIndex:3,state:'duplicate',duplicate:{key:'codex/个人主力',profile:'个人主力',source:'pool'}},{key:'broken',profile:'',fileName:'账号合集.json',sourceIndex:4,state:'error',error:'格式无法识别'});
     if(importMode==='batch-update')Object.assign(initial[0],{profile:data[0].profiles[1].name,email:data[0].profiles[1].meta.email,state:'update'});
     credentialBatch=initial;
     return {id:'credentials-'+(++credentialPreviewId),kind:'credentials',items:credentialBatch};
   }
   return importMode==='encrypted'?{id:'encrypted',needsPassword:true,fileName:'test-backup.ags'}:{id:'preview',items:importItems};
 },
 unlockImport:async(id,password)=>{calls.push({method:'unlock-import',id}); return password==='test-password'?{id:'preview',items:importItems}:{ok:false,error:'密码不正确'};},
 previewCredentials:async(text,id)=>{calls.push({method:'preview-credentials',id}); try{ const value=JSON.parse(text); if(!value.tokens?.refresh_token) throw new Error();credentialBatch=[{key:`${id}/pasted`,agent:id,profile:'pasted',email:'pasted@example.test',state:'ready'}];return {id:'credentials-'+(++credentialPreviewId),kind:'credentials',items:credentialBatch}; }catch{return {ok:false,error:'请提供完整的客户端凭据 JSON'};}},
 commitImport:async(id,keys,names)=>{
   calls.push({method:'import',id,keys,names});
   if(id.startsWith('credentials-')){
     const updated=keys.filter(key=>credentialBatch.find(x=>x.key===key)?.state==='update').map(key=>'codex/'+names[key]);
     for(const key of updated){const p=data[0].profiles.find(p=>p.name===key.slice(6));p.meta.snapshot={...p.meta.snapshot,state:'unverified',authExpired:false};}
     return {imported:keys.filter(key=>credentialBatch.find(x=>x.key===key)?.state!=='update').map(key=>'codex/'+names[key]),updated,skipped:credentialBatch.filter(x=>x.state==='duplicate').map(x=>({key:x.key,existing:x.duplicate.key})),failed:credentialBatch.filter(x=>x.state==='error')};
   }
   const duplicateKeys=importMode==='duplicates'?keys:importMode==='mixed'?keys.slice(0,1):[];return {imported:keys.filter(key=>!duplicateKeys.includes(key)),skipped:duplicateKeys.map(key=>({key,existing:'codex/already-saved'}))};
 },
 previewCredentialUpdate:async(id,name,text)=>{
   calls.push({method:'preview-update',id,name,source:text===undefined?'file':'paste'});
   if(text===undefined&&importMode==='canceled')return {canceled:true};
   if(text!==undefined){try{const value=JSON.parse(text);if(value.tokens?.account_id!=='matching')return {ok:false,error:'凭据不属于此账号或工作区，未进行更新'};}catch{return {ok:false,error:'请提供完整的客户端凭据 JSON'};}}
   pendingCredentialUpdate={id,name};return {id:'update-preview',updating:true,profile:name,items:[{key:`${id}/${name}`,agent:id,profile:name}]};
 },
 commitCredentialUpdate:async()=>{
   const {id,name}=pendingCredentialUpdate;calls.push({method:'update',id,name});
   const a=data.find(a=>a.id===id),p=a.profiles.find(p=>p.name===name);
   p.meta.snapshot={...p.meta.snapshot,state:'unverified',authExpired:false};if(p.isActive)a.status=p.meta.snapshot;
   pendingCredentialUpdate=undefined;return {ok:true,agent:id,profile:name};
 },
 cancelImport:async()=>{calls.push({method:'cancel-import'});},
 refreshAccount:async(id,name,force)=>{if(typeof force!=='boolean')throw new Error('force must be a boolean');calls.push({method:'refresh',id,name,force}); if(refreshBarrier)await refreshBarrier; if(blockNextRefresh){blockNextRefresh=false; await new Promise(resolve=>{releaseRefresh=resolve;}); releaseRefresh=undefined;} if(failNextRefresh){failNextRefresh=false;return {ok:false,error:'fixture query failed'};} const status=data.find(a=>a.id===id)?.profiles.find(p=>p.name===name)?.meta.snapshot || data[0].status; if(reuseNextRefresh){reuseNextRefresh=false;return status;} if(status.state==='unverified'){status.state='ok';status.authExpired=false;}status.checkedAt=new Date().toISOString();status.fetchedAt=status.checkedAt;if(nextRefreshCredit!==undefined){status.quota.credits={balance:nextRefreshCredit};nextRefreshCredit=undefined;} return status;},
 loginStatus:async id=>{
   const status=((id==='codex'||data.find(a=>a.id===id)?.management?.isolatedLogin) && browserLogin) || {ready:true,account:'new@example.test'};
   if(!status.updateProfile){
     const existing=data.find(a=>a.id===id)?.profiles.find(p=>p.meta.email===status.email);
     return {...status,existingProfile:existing?.name,existingProfileUpdatable:existing?.meta.snapshot?.state==='expired'};
   }
   const profile=data[0].profiles.find(p=>p.name===status.updateProfile);
   return {...status,matchesTarget:status.email===profile?.meta.email};
 },
 saveProfile:async(id,name,attempt)=>{
   calls.push({method:'save',id,name,attempt});
   if(blockNextSave){blockNextSave=false;await new Promise(resolve=>{releaseSave=resolve;});releaseSave=undefined;}
   const existing=data.find(a=>a.id===id)?.profiles.find(p=>p.meta.email===browserLogin?.email&&p.meta.snapshot?.state==='expired');
   if(existing)existing.meta.snapshot={...existing.meta.snapshot,state:'unverified',authExpired:false};
   if(id==='agy'&&browserLogin?.ready&&!existing)data[2].profiles.push({name,meta:{email:browserLogin.email,snapshot:{available:true,account:browserLogin.email,state:'unverified'}}});
   browserLogin=undefined;return {ok:true,...(existing?{updated:true,profile:existing.name}:{})};
 },
 updateFromLogin:async(id,name,attempt)=>{
   const a=data.find(a=>a.id===id),p=a.profiles.find(p=>p.name===name);
   if(!browserLogin?.ready||browserLogin.attempt!==attempt||browserLogin.updateProfile!==name||browserLogin.email!==p.meta.email)return {ok:false,error:'登录账号不匹配'};
   calls.push({method:'update-login',id,name,attempt});
   p.meta.snapshot={...p.meta.snapshot,state:'unverified',authExpired:false};if(p.isActive)a.status=p.meta.snapshot;
   browserLogin=undefined;return {ok:true,agent:id,profile:name};
 },
 renameProfile:async(id,oldName,newName)=>{calls.push({method:'rename',id,oldName,newName});if(blockNextRename){blockNextRename=false;await new Promise(resolve=>{releaseRename=resolve;});releaseRename=undefined;}const agent=data.find(a=>a.id===id),profile=agent.profiles.find(p=>p.name===oldName);if(agent.profiles.some(p=>p!==profile&&p.name===newName))return {ok:false,error:'该名称已被使用'};profile.name=newName;if(profile.meta.label)profile.meta.label=newName;if(agent.active===oldName)agent.active=newName;return {ok:true,name:newName};},
 useProfile:async(id,name)=>{calls.push({method:'switch',id,name}); const a=data.find(a=>a.id===id); a.profiles.forEach(p=>p.isActive=p.name===name); a.active=name; a.status=a.profiles.find(p=>p.isActive).meta.snapshot; return {ok:true};},
 previewDeleteProfile:async(agent,name)=>{
   calls.push({method:'preview-delete',agent,name});
   if(blockNextDeletePreview){blockNextDeletePreview=false;await new Promise(resolve=>{releaseDeletePreview=resolve;});releaseDeletePreview=undefined;}
   if(failNextDeletePreview){failNextDeletePreview=false;return {ok:false,error:'模拟范围核对失败'};}
   const a=data.find(a=>a.id===agent),identity=fixtureAliases.get(name)||name;
   const profiles=a.profiles.filter(p=>(fixtureAliases.get(p.name)||p.name)===identity).map(p=>p.name);
   if(!profiles.length)return {ok:false,error:'账号不存在'};
   const preview={id:String(++deletePreviewId),profiles,current:profiles.includes(a.active),logoutUnsupported};
   deletionPreviews.set(preview.id,{...preview,agent,name});return preview;
 },
 deleteProfile:async(id,name,options)=>{
   calls.push({method:'delete',id,name,options});
   const preview=deletionPreviews.get(options?.previewId);
   if(!preview||preview.agent!==id||preview.name!==name)return {ok:false,error:'请重新核对删除范围'};
   if(blockNextDelete){blockNextDelete=false;await new Promise(resolve=>{releaseDelete=resolve;});releaseDelete=undefined;}
   if(failNextDelete){failNextDelete=false;return {ok:false,error:'模拟删除失败'};}
   const a=data.find(a=>a.id===id);a.profiles=a.profiles.filter(p=>!preview.profiles.includes(p.name));if(preview.profiles.includes(a.active))a.active=undefined;
   if(options.logout)a.status={available:false,state:'signed-out'};
   deletionPreviews.delete(preview.id);
   return {ok:true,removed:preview.profiles,loggedOut:options.logout};
 }, exportProfiles:async(items)=>{calls.push({method:'export',items}); return {count:items.length};},
 launchLogin:async(id,mode='open',seenAttempt,updateProfile)=>{
   if((id==='codex'||data.find(a=>a.id===id)?.management?.isolatedLogin) && (!browserLogin || browserLogin.ready || browserLogin.updateProfile!==updateProfile)) browserLogin={attempt:++loginSequence,ready:false,isolated:true,account:'等待浏览器登录',updateProfile};
   calls.push({method:'login',id,mode,attempt:browserLogin?.attempt,updateProfile});
   return {ok:true,message:mode==='copy'||(mode==='private'&&!settings.openPrivateLogin)?'链接已复制，可在本机无痕窗口中打开':mode==='private'?'已打开无痕窗口，请完成登录':'已打开浏览器，登录后即可保存账号'};
 },restartClient:async()=>({canceled:true}),cancelLogin:async()=>{browserLogin=undefined;return {ok:true};},
});
