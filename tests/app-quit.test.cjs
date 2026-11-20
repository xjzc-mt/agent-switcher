const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createQuitGuard } = require('../dist/app-quit');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(overrides = {}) {
  const calls = [];
  const guard = createQuitGuard({
    hasDrafts: () => false,
    isDownloading: () => false,
    confirm: async () => { calls.push('confirm'); return true; },
    cleanup: async () => { calls.push('cleanup'); },
    quit: () => { calls.push('quit'); },
    onError: error => { calls.push(error.message); },
    ...overrides,
  });
  return { guard, calls };
}

test('quit waits for writes and sees a draft produced by an in-flight import', async () => {
  const importRead = deferred(), renewal = deferred();
  let draft = false;
  const waiting = [];
  const { guard, calls } = setup({ hasDrafts: () => draft, onWaiting: value => waiting.push(value) });
  const importing = guard.run(async () => { await importRead.promise; draft = true; });
  const refreshing = guard.run(() => renewal.promise);
  const first = guard.request();
  assert.equal(guard.request(), first);
  importRead.resolve();
  await importing;
  assert.deepEqual(calls, []);
  renewal.resolve();
  await refreshing;
  await first;
  assert.deepEqual(calls, ['confirm', 'cleanup', 'quit']);
  assert.deepEqual(waiting, [true, false]);
  assert.equal(guard.canQuit(), true);
  await guard.request();
  assert.deepEqual(calls, ['confirm', 'cleanup', 'quit']);
});

test('active download alone requires confirmation, and cleanup failure allows retry', async () => {
  let attempt = 0;
  const { guard, calls } = setup({
    isDownloading: () => true,
    cleanup: async () => { if (++attempt === 1) throw new Error('cleanup failed'); },
  });
  await guard.request();
  assert.deepEqual(calls, ['confirm', 'cleanup failed']);
  assert.equal(guard.isClosing(), false);
  assert.equal(guard.canQuit(), false);
  await guard.request();
  assert.deepEqual(calls, ['confirm', 'cleanup failed', 'confirm', 'quit']);
  assert.equal(guard.canQuit(), true);
});

test('failed writes settle without hanging quit and no empty confirmation is shown', async () => {
  const write = deferred();
  const { guard, calls } = setup();
  const writing = guard.run(() => write.promise);
  const rejected = assert.rejects(writing, /write failed/);
  const request = guard.request();
  write.reject(new Error('write failed'));
  await rejected;
  await request;
  assert.deepEqual(calls, ['cleanup', 'quit']);
  assert.equal(guard.canQuit(), true);
});

test('the final exit decision drains or refuses a commit queued at cleanup completion', async () => {
  const write = deferred();
  let accepted = false, saved = false, lateCommit;
  const { guard, calls } = setup({
    cleanup() {
      const finished = Promise.resolve();
      finished.then(() => queueMicrotask(() => {
        accepted = !guard.canQuit();
        lateCommit = guard.trackCritical(async () => { await write.promise; saved = true; });
        lateCommit.catch(() => {});
      }));
      return finished;
    },
    quit() { calls.push('quit'); assert.ok(!accepted || saved); },
  });
  const quitting = guard.request();
  await new Promise(resolve => setImmediate(resolve));
  write.resolve();
  await quitting;
  if (accepted) await lateCommit;
  else await assert.rejects(lateCommit, /已退出/);
  assert.deepEqual(calls, ['quit']);
  assert.ok(guard.canQuit());
});

test('quit drains new rotation commits registered during confirmation and cleanup', async () => {
  const confirm = deferred(), cleanup = deferred();
  const duringConfirm = deferred(), duringCleanup = deferred();
  const events = [];
  const { guard } = setup({
    hasDrafts: () => true,
    confirm: () => { events.push('confirm'); return confirm.promise; },
    cleanup: () => { events.push('cleanup'); return cleanup.promise; },
    quit: () => events.push('quit'),
  });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const request = guard.request();
  await tick();
  assert.deepEqual(events, ['confirm']);
  guard.trackCritical(() => duringConfirm.promise);
  confirm.resolve(true);
  await tick();
  assert.deepEqual(events, ['confirm']);
  duringConfirm.resolve();
  await tick();
  assert.deepEqual(events, ['confirm', 'cleanup']);
  guard.trackCritical(() => duringCleanup.promise);
  cleanup.resolve();
  await tick();
  assert.deepEqual(events, ['confirm', 'cleanup']);
  duringCleanup.resolve();
  await request;
  assert.deepEqual(events, ['confirm', 'cleanup', 'quit']);
  await assert.rejects(guard.trackCritical(() => 'too-late'), /已退出/);
});
