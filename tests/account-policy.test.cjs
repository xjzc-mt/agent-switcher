const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../renderer/account-policy');
const now = Date.now();
function account(name, used, weekly, overrides = {}) {
  return { name, status: { state:'ok', plan:'plus', fetchedAt:new Date(now).toISOString(), quota:{primaryWindow:{usedPercent:used,windowMins:300,resetsAt:now/1000+3600},secondaryWindow:{usedPercent:weekly,windowMins:10080,resetsAt:now/1000+86400}}, ...overrides } };
}
test('Plus compares short remaining quota first, then weekly quota without a low-quota bucket', () => {
  const profiles = [account('short-98',2,0), account('week-5',0,95), account('week-55',0,45), account('empty-week',0,100), account('empty-short',100,42)];
  assert.deepEqual(profiles.sort((a,b)=>policy.compare(a,b,now)).map(a=>a.name), ['week-55','week-5','short-98','empty-short','empty-week']);
});
test('plans stay grouped instead of comparing percentages across tiers', () => {
  const plus = account('plus',95,95), pro = account('pro',0,0,{plan:'pro'});
  assert.equal(Math.sign(policy.compare(plus,pro,now)), Math.sign('plus'.localeCompare('pro','zh-CN')));
});
test('reset periods and unsuccessful samples do not have confirmed quota', () => {
  const sample = account('sample', 0, 0).status;
  for (const overrides of [{ fetchedAt:'invalid' }, { state:'error' }, { state:'unverified' }, { quota:undefined }]) {
    assert.equal(policy.quotaConfirmed({ ...sample, ...overrides }, now), false);
  }
  sample.quota.secondaryWindow.resetsAt = now / 1000;
  assert.equal(policy.quotaConfirmed(sample, now), false);
});
test('quota window formatting keeps fractional balances, query failures and independent reset times', () => {
  const status = account('windows', 99.8, 8).status;
  const {primaryWindow:short, secondaryWindow:week} = status.quota;
  const atReset = short.resetsAt * 1000;
  const view = (w, at) => policy.quotaWindowView(w, policy.queryInvalidated(status), at);
  assert.deepEqual([view(short, now).text, view(short, now).tone], ['<1%', 'low']);
  assert.equal(view(short, atReset).tone, 'cached');
  assert.equal(view(week, atReset).tone, 'ample');
  status.state = 'error';
  assert.deepEqual(view(week, now), { remaining:92, text:'92%', invalidated:true, tone:'cached' });
});
test('refresh age preserves last successful values and their comparison order', () => {
  const ample=account('z-ample',5,10), low=account('a-low',80,95), empty=account('b-empty',0,100);
  const sorted=()=>[low,empty,ample].sort((a,b)=>policy.compare(a,b,now)).map(a=>a.name);
  const original=sorted();
  for(const a of [ample,low,empty])a.status.fetchedAt=new Date(now-600000).toISOString();
  assert.equal(policy.stale(ample.status,now),true);
  assert.equal(policy.invalidated(ample.status,now),false);
  assert.deepEqual(sorted(),original);
  low.status.fetchedAt=new Date(now).toISOString();
  assert.deepEqual(sorted(),original,'One refreshed account must not jump ahead of older successful samples');
});
test('weekly-only and monthly-only quotas align with the long-window column', () => {
  for (const minutes of [10080,43200]) {
    const status={quota:{primaryWindow:{usedPercent:10,windowMins:minutes}}};
    assert.equal(policy.columns(status)[0],undefined);
    assert.equal(policy.columns(status)[1].windowMins,minutes);
  }
});
test('official Pro plan IDs display their price tiers in one family', () => {
  for(const [plan,tier] of [['prolite','100'],['pro','200'],['promax','500'],['pro_200','200'],['Pro·500','500'],['pro $100','100']]) {
    assert.deepEqual(policy.planInfo({plan}),{key:'pro',label:'Pro',tier});
  }
  assert.equal(policy.planInfo({plan:'self_serve_business_prolite'}).key,'self_serve_business_prolite');
  assert.equal(policy.planInfo({plan:'unknown'}).tier,'');
});
test('Pro uses weighted remaining amounts across tiers and keeps unconfirmed quota last', () => {
  const pro = (name, plan, percent, overrides = {}) => {
    const a = account(name,0,100-percent,{plan,...overrides});
    delete a.status.quota.primaryWindow;
    return a;
  };
  const profiles = [pro('200-30','pro',30),pro('100-100','prolite',100),pro('200-80','pro',80),pro('500-9','promax',9),pro('100-40','prolite',40),pro('500-failed','promax',100,{state:'error'})];
  assert.deepEqual(profiles.sort((a,b)=>policy.compare(a,b,now)).map(a=>a.name), ['200-80','100-100','200-30','500-9','100-40','500-failed']);
});
test('Plus incomplete periods retain known values and sort after complete exhausted accounts', () => {
  const shortOnly=account('short-only',0,0),weekOnly=account('week-only',0,10),empty=account('empty',100,100);
  delete shortOnly.status.quota.secondaryWindow;
  delete weekOnly.status.quota.primaryWindow;
  assert.deepEqual([weekOnly,empty,shortOnly].sort((a,b)=>policy.compare(a,b,now)).map(a=>a.name),['empty','short-only','week-only']);
  assert.deepEqual(policy.quotaSlots(weekOnly.status).map(w=>[w.windowMins,w.usedPercent]),[[300,undefined],[10080,10]]);
  assert.deepEqual(policy.quotaSlots(shortOnly.status).map(w=>[w.windowMins,w.usedPercent]),[[300,0],[10080,undefined]]);
  assert.deepEqual(policy.quotaSlots({state:'error',plan:'plus'}),[]);
});
test('Codex period placeholders and tier weights do not apply to other Agents', () => {
  const a=account('a',0,10,{plan:'pro'}),b=account('b',0,20,{plan:'pro'});
  delete a.status.quota.primaryWindow;delete b.status.quota.primaryWindow;
  for(const p of [a,b])p.status.quota.buckets=[{id:'Gemini Models',label:'Gemini',windows:[p.status.quota.secondaryWindow]}];
  assert.ok(policy.compare(a,b,now,'agy')<0);
  a.status.plan='plus';
  assert.equal(policy.quotaSlots(a.status,'agy').length,1);
  assert.equal(policy.quotaConfirmed(a.status,now,'agy'),true);
});
test('reset-card expiry compares calendar dates rather than a rolling 24 hours', () => {
  const now = new Date(2026, 10, 6, 0, 5).getTime();
  const expiry = (day, hour) => ({status:'available', expiresAt:new Date(2026, 10, day, hour).getTime()/1000});
  assert.equal(policy.resetExpiryDays({credits:[expiry(7,23)]},now),1,'Tomorrow counts even when almost 48 hours away');
  assert.equal(policy.resetExpiryDays({credits:[expiry(8,0)]},now),2);
  assert.equal(policy.resetExpiryDays({credits:[expiry(6,0)]},now),0,'All of today uses the same label');
  assert.equal(policy.resetExpiryDays({credits:[expiry(10,12),expiry(7,23)]},now),1,'Report the nearest card');
  assert.equal(policy.resetExpiryDays({credits:[expiry(5,23),{...expiry(6,12),status:'redeemed'},expiry(8,0)]},now),2);
});
test('reset-card dates cross month boundaries and preserve unknown expiry', () => {
  const now = new Date(2026, 9, 31, 23, 59).getTime();
  assert.equal(policy.resetExpiryDays({credits:[{status:'available',expiresAt:new Date(2026,10,1,0,1).getTime()/1000}]},now),1);
  for(const credits of [null,[],[{status:'available',expiresAt:null}],[{status:'available',expiresAt:Infinity}],[{status:'available',expiresAt:-1}]])assert.equal(policy.resetExpiryDays({credits},now),null);
});

test('Antigravity ranks Gemini independently and keeps other limits available for refresh', () => {
  const now = Date.now(), future = now / 1000 + 3600;
  const make = (short, week) => ({state:'ok',plan:'Google AI Pro',fetchedAt:new Date(now).toISOString(),quota:{buckets:[
    {id:'Gemini 4 Argon Models',label:'Gemini 4 Argon',windows:[{windowMins:10080,usedPercent:100,resetsAt:future}]},
    {id:'Claude and GPT Models',label:'Claude / GPT',windows:[{windowMins:300,usedPercent:100,resetsAt:future}]},
    {id:'Gemini Models',label:'Gemini',windows:[{windowMins:300,usedPercent:100-short,resetsAt:future},{windowMins:10080,usedPercent:100-week,resetsAt:future}]},
  ]}});
  const high=make(90,20), low=make(70,80), exhausted=make(100,0);
  assert.equal(policy.windows(high,'codex').length,0,'Codex model buckets are separate from account limits');
  assert.equal(policy.modelBucket(high,'gemini').id,'Gemini Models');
  assert.equal(policy.modelBucket(high,'claude').id,'Claude and GPT Models');
  assert.ok(policy.compare({name:'high',status:high},{name:'low',status:low},now,'agy')<0);
  assert.ok(policy.compare({name:'empty',status:exhausted},{name:'low',status:low},now,'agy')>0);
  high.quota.buckets[0].windows[0].resetsAt=now/1000-1;
  assert.equal(policy.quotaConfirmed(high,now,'agy'),true,'An Argon reset must not invalidate Gemini ranking');
  assert.equal(policy.invalidated(high,now,'agy'),true,'All model groups still trigger refresh');
  assert.equal(policy.windows(high,'agy').length,4);
  high.quota.buckets.pop();
  assert.deepEqual(policy.quotaSlots(high,'agy'),[],'Argon must never stand in for a missing Gemini group');
  assert.equal(policy.quotaConfirmed(high,now,'agy'),false);
  const missing=make(90,80);delete missing.quota.buckets[2].windows[0].usedPercent;
  assert.equal(policy.quotaSlots(missing,'agy').length,2,'Keep an explicitly missing period for display');
  assert.equal(policy.quotaConfirmed(missing,now,'agy'),false);
});
