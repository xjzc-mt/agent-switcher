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

test('cancelled quit keeps drafts and downloads intact and permits new work', async () => {
  const confirmation = deferred();
  const { guard, calls } = setup({ hasDrafts: () => true, isDownloading: () => true, confirm: () => confirmation.promise });
  const request = guard.request();
  assert.equal(guard.isClosing(), true);
  await assert.rejects(guard.run(() => assert.fail('must not start')), /准备退出/);
  confirmation.resolve(false);
  await request;
  assert.deepEqual(calls, []);
  assert.equal(guard.canQuit(), false);
  assert.equal(guard.isClosing(), false);
  assert.equal(await guard.run(() => 'saved'), 'saved');
});

test('quit waits for writes and sees a draft produced by an in-flight import', async () => {
  const importRead = deferred(), renewal = deferred();
  let draft = false;
  const { guard, calls } = setup({ hasDrafts: () => draft });
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

test('quit is allowed only after cleanup has completed', async () => {
  const cleanup = deferred();
  const { guard, calls } = setup({ cleanup: () => cleanup.promise });
  const request = guard.request();
  await Promise.resolve();
  assert.equal(guard.canQuit(), false);
  assert.deepEqual(calls, []);
  cleanup.resolve();
  await request;
  assert.equal(guard.canQuit(), true);
  assert.deepEqual(calls, ['quit']);
});
