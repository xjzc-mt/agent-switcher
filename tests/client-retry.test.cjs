const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openClients, loginInTerminal } = require('../dist/clients.js');

test('opening a client retries twice after launch errors', async () => {
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

test('Terminal automation denial gives a useful import alternative without leaking the command', {skip:process.platform!=='darwin'},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ags-terminal-denial-'));
  const previousPath=process.env.PATH;
  try{
    fs.writeFileSync(path.join(dir,'osascript'),'#!/bin/sh\nprintf "Not authorized to send Apple events to Terminal. (-1743)\\n" >&2\nexit 1\n',{mode:0o700});
    process.env.PATH=`${dir}${path.delimiter}${previousPath||''}`;
    await assert.rejects(loginInTerminal('/private/example/codex',['login'],{CODEX_HOME:'/private/example/login'}),error=>{
      assert.match(error.message,/macOS.*Terminal.*Session 导入/);
      assert.doesNotMatch(error.message,/Command failed|osascript|\/private\/example/);return true;
    });
  }finally{process.env.PATH=previousPath;fs.rmSync(dir,{recursive:true,force:true});}
});
