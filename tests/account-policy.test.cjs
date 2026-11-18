const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../renderer/account-policy');
const now = Date.now();
function account(name, used, weekly, overrides = {}) {
  return { name, status: { state:'ok', plan:'plus', fetchedAt:new Date(now).toISOString(), quota:{primaryWindow:{usedPercent:used,windowMins:300,resetsAt:now/1000+3600},secondaryWindow:{usedPercent:weekly,windowMins:10080,resetsAt:now/1000+86400}}, ...overrides } };
}
test('a full short window never outweighs an exhausted weekly window', () => {
  const exhausted = account('empty-week',0,100), usable = account('usable',70,70);
  assert.ok(policy.compare(usable, exhausted, now) < 0);
  assert.equal(policy.health(exhausted.status,now).kind,'blocked');
});
test('Plus compares short remaining quota first, then weekly quota without a low-quota bucket', () => {
  const profiles = [account('short-98',2,0), account('week-5',0,95), account('week-55',0,45), account('empty-week',0,100), account('empty-short',100,42)];
  assert.deepEqual(profiles.sort((a,b)=>policy.compare(a,b,now)).map(a=>a.name), ['week-55','week-5','short-98','empty-short','empty-week']);
  assert.ok(policy.compare(account('short-full',0,90), account('balanced',40,40),now)<0);
});
test('plans stay grouped instead of comparing percentages across tiers', () => {
  const plus = account('plus',95,95), pro = account('pro',0,0,{plan:'pro'});
  assert.equal(Math.sign(policy.compare(plus,pro,now)), Math.sign('plus'.localeCompare('pro','zh-CN')));
});
test('invalid, failed or reset-passed samples are never called available', () => {
  for (const overrides of [{fetchedAt:'invalid'},{state:'error'},{state:'expired'},{authExpired:true}]) {
    assert.ok(policy.health(account('a',0,0,overrides).status,now).rank>=3);
  }
  const a = account('a',0,0); a.status.quota.secondaryWindow.resetsAt=now/1000-1;
  assert.equal(policy.health(a.status,now).kind,'unknown');
});
test('refresh age preserves last successful values and their comparison order', () => {
  const ample=account('z-ample',5,10), low=account('a-low',80,95), empty=account('b-empty',0,100);
  const sorted=()=>[low,empty,ample].sort((a,b)=>policy.compare(a,b,now)).map(a=>a.name);
  const original=sorted();
  for(const a of [ample,low,empty])a.status.fetchedAt=new Date(now-600000).toISOString();
  assert.equal(policy.stale(ample.status,now),true);
  assert.equal(policy.invalidated(ample.status,now),false);
  assert.match(policy.health(ample.status,now).label,/上次查询/);
  assert.deepEqual(sorted(),original);
  low.status.fetchedAt=new Date(now).toISOString();
  assert.deepEqual(sorted(),original,'One refreshed account must not jump ahead of older successful samples');
  assert.equal(policy.health(empty.status,now).kind,'blocked','Old 0% must not become available while waiting');
});
test('credits do not turn exhausted subscription quota into available subscription quota', () => {
  const a=account('a',100,100); a.status.quota.credits={balance:'1000'};
  assert.equal(policy.health(a.status,now).kind,'blocked');
});
test('unknown windows remain unknown and fractional remaining quota is not exhausted', () => {
  assert.equal(policy.health({state:'ok',fetchedAt:new Date(now).toISOString()},now).kind,'unknown');
  assert.equal(policy.health(account('a',99.8,0).status,now).kind,'low');
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
test('Pro uses weighted remaining amounts across tiers and keeps unknown and expired accounts last', () => {
  const pro = (name, plan, percent, overrides = {}) => {
    const a = account(name,0,100-percent,{plan,...overrides});
    delete a.status.quota.primaryWindow;
    return a;
  };
  const profiles = [pro('200-30','pro',30),pro('100-100','prolite',100),pro('200-80','pro',80),pro('500-9','promax',9),pro('100-40','prolite',40),pro('100-expired','prolite',100,{state:'expired'}),pro('500-failed','promax',100,{state:'error'})];
  assert.deepEqual(profiles.sort((a,b)=>policy.compare(a,b,now)).map(a=>a.name), ['200-80','100-100','200-30','500-9','100-40','500-failed','100-expired']);
});
test('Plus incomplete periods retain known values and sort after complete exhausted accounts', () => {
  const shortOnly=account('short-only',0,0),weekOnly=account('week-only',0,10),empty=account('empty',100,100),expired=account('expired',0,0,{state:'expired'});
  delete shortOnly.status.quota.secondaryWindow;
  delete weekOnly.status.quota.primaryWindow;
  for(const a of [shortOnly,weekOnly])assert.equal(policy.health(a.status,now).kind,'unknown');
  assert.deepEqual([expired,weekOnly,empty,shortOnly].sort((a,b)=>policy.compare(a,b,now)).map(a=>a.name),['empty','short-only','week-only','expired']);
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
  assert.equal(policy.health(a.status,now,'agy').kind,'ready');
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

test('Antigravity compares model groups without converting Codex model buckets into general quotas', () => {
  const status = { available:true, state:'ok', plan:'Google AI Pro', fetchedAt:new Date().toISOString(),
    quota:{buckets:[{id:'Gemini',label:'Gemini',windows:[{usedPercent:100,windowMins:300}]}]} };
  assert.equal(policy.windows(status, 'agy').length, 1);
  assert.equal(policy.windows(status, 'codex').length, 0);
  assert.equal(policy.health(status, Date.now(), 'agy').label, 'Gemini 额度耗尽');
});

test('Antigravity ranks Gemini independently and keeps other limits available for refresh', () => {
  const now = Date.now(), future = now / 1000 + 3600;
  const make = (short, week) => ({state:'ok',plan:'Google AI Pro',fetchedAt:new Date(now).toISOString(),quota:{buckets:[
    {id:'Gemini 4 Argon Models',label:'Gemini 4 Argon',windows:[{windowMins:10080,usedPercent:100,resetsAt:future}]},
    {id:'Claude and GPT Models',label:'Claude / GPT',windows:[{windowMins:300,usedPercent:100,resetsAt:future}]},
    {id:'Gemini Models',label:'Gemini',windows:[{windowMins:300,usedPercent:100-short,resetsAt:future},{windowMins:10080,usedPercent:100-week,resetsAt:future}]},
  ]}});
  const high=make(90,20), low=make(70,80), exhausted=make(100,0);
  assert.equal(policy.modelBucket(high,'gemini').id,'Gemini Models');
  assert.equal(policy.modelBucket(high,'claude').id,'Claude and GPT Models');
  assert.equal(policy.health(high,now,'agy').rank,0);
  assert.ok(policy.compare({name:'high',status:high},{name:'low',status:low},now,'agy')<0);
  assert.ok(policy.compare({name:'empty',status:exhausted},{name:'low',status:low},now,'agy')>0);
  high.quota.buckets[0].windows[0].resetsAt=now/1000-1;
  assert.equal(policy.health(high,now,'agy').rank,0,'An Argon reset must not invalidate Gemini ranking');
  assert.equal(policy.invalidated(high,now,'agy'),true,'All model groups still trigger refresh');
  assert.equal(policy.windows(high,'agy').length,4);
  high.quota.buckets.pop();
  assert.deepEqual(policy.quotaSlots(high,'agy'),[],'Argon must never stand in for a missing Gemini group');
  assert.equal(policy.health(high,now,'agy').rank,3);
  const missing=make(90,80);delete missing.quota.buckets[2].windows[0].usedPercent;
  assert.equal(policy.quotaSlots(missing,'agy').length,2,'Keep an explicitly missing period for display');
  assert.equal(policy.health(missing,now,'agy').rank,3);
});
