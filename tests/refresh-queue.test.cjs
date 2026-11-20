const {test}=require('node:test');
const assert=require('node:assert/strict');
const Queue=require('../renderer/refresh-queue');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const tick=()=>new Promise(r=>setImmediate(r));

test('each free slot takes the highest-priority account while slow queries remain in flight',async()=>{
  const names=['A','B','C','D','E'];
  const gates=Object.fromEntries(names.map(key=>[key,deferred()]));
  const calls=[];
  const q=new Queue({run:async(key,force)=>{calls.push([key,force]);await gates[key].promise;return key;}});
  const requests=names.map(key=>q.request(key,key));
  await tick();
  assert.deepEqual(calls,[['A',false],['B',false],['C',false]]);
  assert.equal(q.request('E','E',{force:true,priority:2}),requests[4]);
  gates.B.resolve();
  await requests[1];await tick();
  assert.deepEqual(calls.slice(3),[['E',true]]);
  gates.E.resolve();
  await requests[4];await tick();
  assert.deepEqual(calls.slice(4),[['D',false]]);
  gates.A.resolve();gates.C.resolve();gates.D.resolve();
  assert.deepEqual(await Promise.all(requests),names);
  assert.equal(q.jobs.size,0);
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
