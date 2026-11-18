const {test}=require('node:test');
const assert=require('node:assert/strict');
const Queue=require('../renderer/refresh-queue');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const tick=()=>new Promise(r=>setImmediate(r));

test('at most three accounts run together and each free slot is refilled without waiting for slow accounts',async()=>{
  const gates=Object.fromEntries(['A','B','C','D','E'].map(key=>[key,deferred()])),calls=[];
  let active=0,peak=0;
  const q=new Queue({run:async p=>{calls.push(p);peak=Math.max(peak,++active);await gates[p].promise;active--;return p;}});
  const requests=['A','B','C','D','E'].map(key=>q.request(key,key));
  await tick();assert.deepEqual(calls,['A','B','C']);assert.equal(q.get('D').state,'queued');assert.equal(q.get('E').state,'queued');
  gates.B.resolve();assert.equal(await requests[1],'B');await tick();assert.deepEqual(calls,['A','B','C','D']);
  gates.D.resolve();assert.equal(await requests[3],'D');await tick();assert.deepEqual(calls,['A','B','C','D','E']);
  assert.equal(q.get('A').state,'running');assert.equal(q.get('C').state,'running');
  gates.A.resolve();gates.C.resolve();gates.E.resolve();
  assert.deepEqual(await Promise.all(requests),['A','B','C','D','E']);assert.equal(peak,3);assert.equal(active,0);assert.equal(q.jobs.size,0);
});
test('single-account refresh joins an in-flight query instead of issuing another',async()=>{
  const gate=deferred(),calls=[];
  const q=new Queue({run:async(p,force)=>{calls.push({p,force});await gate.promise;return {state:'ok'};}});
  const first=q.request('A','A',{force:true});await tick();
  assert.equal(q.get('A').state,'running');
  assert.equal(q.request('A','A',{force:true}),first);
  gate.resolve();assert.deepEqual(await first,{state:'ok'});assert.equal(calls.length,1);assert.equal(q.get('A'),undefined);
});
test('manual single-account requests overtake queued batch work and upgrade its cache policy',async()=>{
  const gate=deferred(),calls=[];
  const q=new Queue({run:async(p,force)=>{calls.push([p,force]);if(p.startsWith('active'))await gate.promise;return {state:'ok'};}});
  const running=['active1','active2','active3'].map(key=>q.request(key,key));await tick();
  const b=q.request('B','B'),c=q.request('C','C');
  assert.equal(q.request('C','C',{force:true,priority:2}),c);
  gate.resolve();await Promise.all([...running,b,c]);
  assert.deepEqual(calls,[['active1',false],['active2',false],['active3',false],['C',true],['B',false]]);
});
test('automatic work pauses when hidden without cancelling an explicit manual request',async()=>{
  let visible=true;const gate=deferred(),calls=[];
  const q=new Queue({canAutoRefresh:()=>visible,run:async p=>{calls.push(p);if(p.startsWith('active'))await gate.promise;return {state:'ok'};}});
  const running=['active1','active2','active3'].map(key=>q.request(key,key));await tick();
  const b=q.request('B','B'),c=q.request('C','C',{force:true,priority:2});
  visible=false;gate.resolve();await Promise.all(running);assert.deepEqual(await b,{skipped:true});await c;
  assert.deepEqual(calls,['active1','active2','active3','C']);
  visible=true;await q.request('B','B');assert.deepEqual(calls,['active1','active2','active3','C','B']);
});
test('a failed account releases the queue and cannot prevent later accounts from refreshing',async()=>{
  const calls=[];const q=new Queue({run:async p=>{calls.push(p);if(p==='bad')throw new Error('failed');return {state:'ok'};}});
  const results=await Promise.allSettled([q.request('bad','bad'),q.request('good','good')]);
  assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'fulfilled');assert.deepEqual(calls,['bad','good']);assert.equal(q.jobs.size,0);
});
