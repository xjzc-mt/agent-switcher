const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openClients } = require('../dist/clients.js');

test('macOS opening a client retries twice after launch errors', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-open-retry-'));
  const counter = path.join(dir, 'attempts');
  const previousPath = process.env.PATH;
  const previousCounter = process.env.AGS_TEST_RETRY_COUNT;
  try {
    fs.writeFileSync(counter, '0');
    fs.writeFileSync(path.join(dir, 'open'), '#!/bin/sh\ncount=$(cat "$AGS_TEST_RETRY_COUNT")\ncount=$((count + 1))\nprintf "%s" "$count" > "$AGS_TEST_RETRY_COUNT"\n[ "$count" -ge 3 ]\n', { mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'osascript'), '#!/bin/sh\nprintf "false\\n"\n', { mode: 0o700 });
    process.env.PATH = `${dir}${path.delimiter}${previousPath || ''}`;
    process.env.AGS_TEST_RETRY_COUNT = counter;
    await openClients(['Antigravity']);
    assert.equal(fs.readFileSync(counter, 'utf8'), '3');
  } finally {
    process.env.PATH = previousPath;
    if (previousCounter === undefined) delete process.env.AGS_TEST_RETRY_COUNT;
    else process.env.AGS_TEST_RETRY_COUNT = previousCounter;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
