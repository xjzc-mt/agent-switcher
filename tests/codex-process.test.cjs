const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { startCodexProcess } = require('../dist/codex-process');
const { CodexAgent } = require('../dist/agents/codex');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-codex-process-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
function cli(name, body) {
  const file = path.join(root, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return file;
}

test('isolated transport preserves split UTF-8 messages and waits for EOF credential writes', { timeout: 10000 }, async t => {
  const binary = cli('flush', `
    const fs = require('fs');
    process.stdin.once('data', data => {
      const request = JSON.parse(data), bytes = Buffer.from(JSON.stringify({id: request.id, text: '额度',
        home: process.env.CODEX_HOME, cwd: process.cwd(), overrides: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_SQLITE_HOME'].filter(k => process.env[k])}) + '\\n');
      const split = bytes.indexOf(Buffer.from('额度')) + 1;
      process.stdout.write('noise\\nnull\\n42\\n');
      process.stdout.write(bytes.subarray(0, split));
      setTimeout(() => process.stdout.write(bytes.subarray(split)), 20);
    });
    process.stdin.on('end', () => setTimeout(() => fs.writeFileSync('flushed', 'new-credential'), 60));
  `);
  const keys = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_SQLITE_HOME'];
  const previous = keys.map(key => process.env[key]);
  for (const key of keys) process.env[key] = 'fixture-override';
  let server, closeCount = 0;
  try {
    const received = new Promise((resolve, reject) => {
      server = startCodexProcess(binary, root, { onMessage: resolve, onError: reject, onClose: () => closeCount++ });
    });
    t.after(() => server.stop());
    server.send({ id: 7 });
    assert.deepEqual(await received, { id: 7, text: '额度', home: root, cwd: fs.realpathSync(root), overrides: [] });
    const stopped = server.stop();
    assert.equal(server.stop(), stopped);
    await stopped;
    assert.equal(fs.readFileSync(path.join(root, 'flushed'), 'utf8'), 'new-credential');
    assert.equal(closeCount, 1);
    server.send({ id: 8 }); // A late write after cancellation must be harmless.
  } finally {
    keys.forEach((key, index) => previous[index] === undefined ? delete process.env[key] : process.env[key] = previous[index]);
    await server?.stop();
  }
});

test('shutdown reaps a child that ignores EOF and SIGTERM', { timeout: 10000 }, async t => {
  const binary = cli('stubborn', `process.on('SIGTERM', () => {}); process.stdin.resume(); setInterval(() => {}, 1000); console.log(JSON.stringify({pid: process.pid}));`);
  let server, closeCount = 0;
  const ready = new Promise((resolve, reject) => {
    server = startCodexProcess(binary, root, { onMessage: resolve, onError: reject, onClose: () => closeCount++ });
  });
  t.after(() => server.stop());
  const { pid } = await ready;
  await server.stop(10);
  assert.equal(closeCount, 1);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('quota caller distinguishes spawn failure from premature exit and remains reusable', { timeout: 10000 }, async () => {
  const agent = new CodexAgent();
  agent.findCodexBinary = () => path.join(root, 'missing');
  await assert.rejects(agent.queryLiveRpc(root), /无法启动 Codex CLI/);
  const binary = cli('exit', 'process.exit(0);');
  agent.findCodexBinary = () => binary;
  await assert.rejects(agent.queryLiveRpc(root), /查询进程提前退出/);
});
