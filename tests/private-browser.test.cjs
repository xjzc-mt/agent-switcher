const {test,afterEach} = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const {promisify} = require('node:util');
const calls = [];
let bundle = 'com.google.Chrome', failCommand;
const original = childProcess.execFile;
const fake = () => { throw new Error('Expected promisified execFile'); };
fake[promisify.custom] = async (file,args,options) => {
  calls.push({file,args,options});
  if(file===failCommand)throw new Error('sensitive login URL must not escape');
  return {stdout:bundle+'\n',stderr:''};
};
childProcess.execFile = fake;
let openPrivateBrowser;
try { ({openPrivateBrowser}=require('../dist/private-browser')); }
finally { childProcess.execFile=original; }
afterEach(()=>{calls.length=0;bundle='com.google.Chrome';failCommand=undefined;});
const mac = {skip:process.platform!=='darwin'};
const application = '/Applications/My Browser.app';
const url = 'https://auth.openai.com/oauth/authorize?state=fixture&note=$(echo%20unsafe)';
const googleUrl = 'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A12345%2Fcallback&state=fixture';

test('supported default browsers receive a private flag and the unmodified URL as one argument',mac,async()=>{
  for(const [id,flag,target] of [
    ['com.google.Chrome','--incognito',url],
    ['com.microsoft.edgemac','--inprivate',googleUrl],
    ['org.mozilla.firefox','-private-window',url],
  ]) {
    calls.length=0;bundle=id;
    assert.equal(await openPrivateBrowser(application,target),true);
    assert.deepEqual(calls[0].args,['-extract','CFBundleIdentifier','raw','-o','-',application+'/Contents/Info.plist']);
    assert.deepEqual(calls[1].args,['-n','-a',application,'--args',flag,target]);
    assert.equal(calls[1].file,'/usr/bin/open');
    assert.equal(calls[1].options.shell,undefined);
    assert.ok(calls[1].options.timeout<=5000);
  }
});

test('unsupported browsers fall back without opening an ordinary window',mac,async()=>{
  bundle='com.apple.Safari';
  assert.equal(await openPrivateBrowser(application,url),false);
  assert.equal(calls.length,1);
});

test('invalid destinations are rejected and process failures return a safe fallback',mac,async()=>{
  for(const target of ['not-a-url','javascript:alert(1)','https://auth.openai.com.evil.test','https://user:pass@accounts.google.com/oauth','http://accounts.google.com/oauth']){
    assert.equal(await openPrivateBrowser(application,target),false);
  }
  assert.equal(await openPrivateBrowser('relative.app',url),false);
  assert.equal(await openPrivateBrowser('/usr/bin/browser',url),false);
  assert.equal(calls.length,0);
  for(const command of ['/usr/bin/plutil','/usr/bin/open']){
    failCommand=command;
    assert.equal(await openPrivateBrowser(application,url),false);
  }
});
