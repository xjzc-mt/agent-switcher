const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { once } = require('node:events');
const cp = require('node:child_process');
const windows = require('../dist/windows-processes');
const temp = require('../dist/temporary-credentials');
const { runningCodexSessions } = require('../dist/client-logout');
const { isolatedCodexPids } = require('../dist/codex-process');

function asWindows(t) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...original, value:'win32' });
  t.after(() => Object.defineProperty(process, 'platform', original));
}

test('Windows Antigravity guards shared sessions and only reopens the desktop it closed', async t => {
  const rows = [
    { pid: 40, parent: 0, name: 'agy.exe' },
    { pid: 41, parent: 40, name: 'language_server.exe', file: null },
    { pid: 42, parent: 0, name: 'language_server.exe', file: 'C:/Unrelated IDE/language_server.exe' },
    { pid: 43, parent: 0, name: 'language_server_windows_x64.exe', file: 'C:/Apps/Antigravity IDE/resources/app/extensions/antigravity/bin/language_server_windows_x64.exe' },
    { pid: 44, parent: 0, name: 'agy.exe' },
  ];
  for (const row of rows) row.ownerKnown = row.pid !== 42;
  assert.deepEqual(windows.sharedWindowsAntigravityPids(rows, new Set([40])), [43, 44]);
  assert.deepEqual(windows.sharedWindowsAntigravityPids([{...rows[1], ownerKnown:false}], new Set()), []);
  assert.throws(() => windows.sharedWindowsAntigravityPids([{...rows[3], file:null}], new Set()), /无法确认/);

  const root = (fs.realpathSync.native || fs.realpathSync)(fs.mkdtempSync(path.join(os.tmpdir(), 'ags-desktop-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  asWindows(t);
  const clients = require('../dist/clients'), { EventEmitter } = require('node:events');
  const desktop = path.join(root, 'custom', 'Antigravity.exe');
  fs.mkdirSync(path.join(path.dirname(desktop), 'resources'), { recursive: true });
  fs.writeFileSync(desktop, 'desktop'); fs.writeFileSync(path.join(root, 'custom', 'resources', 'app.asar'), 'app');
  const agy = { pid: 65, file: desktop, name:'Antigravity.exe', ownerKnown:true, created:'133820340000000002' };
  let running = [agy], publisher = 'Unrelated company';
  t.mock.method(windows, 'desktopCandidates', async () => running);
  t.mock.method(require('../dist/windows-helper'), 'windowsHelper', () => 'fixture-helper');
  let closes = 0, elevated = false;
  t.mock.method(cp, 'execFile', (exe, args, opts, callback) => {
    assert.equal(exe, 'fixture-helper');
    if (args[0] === 'publisher') { assert.deepEqual(args,['publisher',desktop]); return callback(null,publisher); }
    assert.deepEqual(args,[desktop,'window:65:133820340000000002']);
    if (elevated) return callback(Object.assign(new Error(), {code:5}));
    closes++;
    running = []; callback(null,'');
  });
  const launch = t.mock.method(cp, 'spawn', (file, args) => {
    assert.equal(file, desktop); assert.deepEqual(args, []);
    const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child;
  });
  assert.deepEqual(await clients.runningClients('agy'), ['Antigravity']);
  await assert.rejects(clients.quitClients(['Antigravity']), /安装位置/);
  assert.equal(closes, 0);
  publisher = 'Google LLC'; elevated = true;
  await assert.rejects(clients.quitClients(['Antigravity']), /管理员身份/);
  elevated = false;
  await clients.quitClients(['Antigravity']); assert.deepEqual(await clients.runningClients('agy'), []);
  await clients.openClients(['Antigravity']);
  running = [agy]; await clients.quitClients(['Antigravity']); fs.appendFileSync(desktop, 'updated');
  await assert.rejects(clients.openClients(['Antigravity']), /已变更/);
  assert.equal(launch.mock.callCount(), 1);
});

test('Windows restarts the registered Codex desktop and waits for its backend while preserving independent terminals', async t => {
  const root = (fs.realpathSync.native || fs.realpathSync)(fs.mkdtempSync(path.join(os.tmpdir(), 'ags-codex-desktop-')));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  asWindows(t);
  const clients = require('../dist/clients'), { EventEmitter } = require('node:events');
  const family = 'OpenAI.Codex_2p2nqsd0c76g0';
  const file = path.join(root, 'WindowsApps', 'OpenAI.Codex_26.0.0_x64__2p2nqsd0c76g0', 'app', 'ChatGPT.exe');
  fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, 'desktop');
  const manifest = path.join(path.dirname(path.dirname(file)), 'AppxManifest.xml');
  fs.writeFileSync(manifest, 'fixture');
  const app = { pid:90, created:'133820340000000001', ownerKnown:true, file };
  const terminal = { pid:75, created:'133820340000000002', ownerKnown:true, file:path.join(root,'bin','codex.exe') };
  const other = { ...app, pid:81, file:file.replace('2p2nqsd0c76g0','anotherpublisher').replace('ChatGPT.exe','Codex.exe') };
  const renderer = { pid:94, parent:90, created:'133820340000000004', ownerKnown:false, file:null };
  let running = [renderer,app,terminal,other], registered = '', manifestUnreadable = false;
  let closes = 0, manifests = 0, fallbacks = 0;
  t.mock.method(windows,'desktopCandidates',async () => running);
  t.mock.method(require('../dist/windows-helper'),'windowsHelper',() => 'desktop-helper');
  t.mock.method(cp,'execFile',(exe,args,opts,callback) => {
    if (exe !== 'desktop-helper') {
      assert.match(exe,/powershell\.exe$/i);
      assert.equal(opts.env.AGS_DESKTOP_FILE,file); assert.equal(opts.env.AGS_CODEX_FAMILY,family);
      assert.equal(opts.timeout,10000); fallbacks++; return callback(null,registered);
    }
    if (args[0] === 'manifest') {
      manifests++; assert.deepEqual(args,['manifest',file]);
      return manifestUnreadable ? callback(Object.assign(new Error(),{code:3})) : callback(null,registered);
    }
    if (args[0] === 'processes') {
      assert.deepEqual(args,['processes']);
      const all = [
        [92,91,'133820340000000003','codex-app-server.exe'], [91,90,'133820340000000002','shell.exe'],
        [90,1,app.created,'ChatGPT.exe'], [75,1,terminal.created,'codex.exe'],
        [76,90,'133820340000000000','codex.exe'], // Older than the current occupant of parent PID 90.
      ].map(([pid,parent,created,name]) => ({pid,parent,created,name,ownerKnown:true,file:null}));
      return callback(null,JSON.stringify(all));
    }
    assert.deepEqual(args,[file,'wait:94:133820340000000004','window:90:133820340000000001','wait:92:133820340000000003']);
    closes++; running = [terminal,other]; callback(null,'');
  });
  const launch = t.mock.method(cp,'spawn',(exe,args) => {
    assert.match(exe,/explorer\.exe$/i); assert.deepEqual(args,['shell:AppsFolder\\' + family + '!App']);
    const child = new EventEmitter(); child.unref = () => {};
    running = [app,terminal]; queueMicrotask(() => child.emit('spawn')); return child;
  });
  const inventory = require('../dist/windows-desktop');
  running = [{ ...renderer, created:'133820339999999999' },app]; // An unknown PID cannot borrow a newer parent's identity.
  await assert.rejects(inventory.windowsDesktop('Codex'), /管理员身份/);
  running = [renderer,app,terminal,other];
  const confirmed = await clients.runningClients('codex');
  assert.deepEqual(confirmed, ['Codex']);
  await assert.rejects(clients.quitClients(confirmed), /启动项/);
  assert.deepEqual([closes, fallbacks], [0,0]);
  registered = 'App';
  running = [{ ...app, created:'133820340000000099' },terminal,other]; // PID reused while confirmation is open.
  await assert.rejects(clients.quitClients(confirmed), /已重新启动/);
  assert.equal(closes, 0);
  running = [renderer,app,terminal,other];
  await clients.quitClients(confirmed); assert.deepEqual(await clients.runningClients('codex'),[]);
  t.mock.method(windows,'windowsCodexProcesses',async () => [terminal.pid]);
  assert.deepEqual(await runningCodexSessions({failClosed:true}),[terminal.pid]);
  await clients.openClients(['Codex']); assert.equal(launch.mock.callCount(),1);
  // A known immutable package reuses its manifest. Only an inaccessible replacement invokes the package query.
  const previousManifests = manifests;
  running = [renderer,app]; await clients.quitClients(await clients.runningClients('codex'));
  assert.deepEqual([manifests, fallbacks], [previousManifests,0]);
  fs.appendFileSync(manifest, 'updated'); manifestUnreadable = true;
  running = [renderer,app]; await clients.quitClients(await clients.runningClients('codex'));
  assert.deepEqual([manifests, fallbacks], [previousManifests+1,1]);
  running = [app,terminal];
  const reopenConfirmed = await clients.runningClients('codex');
  running = [terminal,other]; // The user quit during the confirmation dialog.
  await assert.rejects(clients.quitClients(reopenConfirmed),/已退出/);
  assert.equal(launch.mock.callCount(),1);

  const regular = path.join(root, 'Programs', 'OpenAI', 'Codex', 'Codex.exe');
  const resources = path.join(path.dirname(regular), 'resources');
  fs.mkdirSync(resources, { recursive:true }); fs.writeFileSync(regular, 'fixture');
  running = [{ ...app, file:regular }, terminal];
  assert.deepEqual(await clients.runningClients('codex'), []); // A CLI by itself has no desktop windows.
  fs.writeFileSync(path.join(resources, 'app.asar'), 'desktop');
  assert.deepEqual(await clients.runningClients('codex'), ['Codex']);
});

test('Windows live session detection excludes a local isolated query and propagates an unknown inventory', async t => {
  asWindows(t);
  const inventory = t.mock.method(windows, 'windowsCodexProcesses', async () => [201,202]);
  isolatedCodexPids.add(201);
  t.after(() => isolatedCodexPids.delete(201));
  assert.deepEqual(await runningCodexSessions({ failClosed:true }), [202]);
  t.mock.method(require('../dist/store'), 'withStoreLock', task => task());
  t.mock.method(require('../dist/store'), 'profileDir', () => 'fixture-directory');
  const agent = new (require('../dist/agents/codex').CodexAgent)();
  t.mock.method(agent, 'identity', () => undefined);
  t.mock.method(agent, 'switchSupport', () => undefined);
  await assert.rejects(require('../dist/accounts').useAccount(agent, 'fixture'), /先退出 Codex/);
  inventory.mock.mockImplementation(async () => { throw new Error('inventory unavailable'); });
  await assert.rejects(runningCodexSessions({ failClosed:true }), /inventory unavailable/);
});

test('Windows probe failures preserve recovery guidance and record the switch stage', async t => {
  const { initializeDiagnostics, runDiagnostic, exportDiagnostics } = require('../dist/diagnostics');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'ags-win-diagnostic-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  initializeDiagnostics(dir,'0.1.0');
  t.mock.method(require('../dist/windows-helper'), 'windowsHelper', () => 'native-helper');
  let response;
  t.mock.method(cp, 'execFile', (exe, args, opts, callback) => {
    assert.equal(exe,'native-helper'); assert.equal(args[0],'processes');
    response instanceof Error ? callback(response) : callback(null,response);
  });
  const unknown = {pid:41,parent:1,created:'133820340000000001',name:'codex.exe',file:null,ownerKnown:false};
  for (const [data, message, result] of [
    [JSON.stringify([unknown]), /管理员身份/, 'failed'],
    [Object.assign(new Error(),{killed:true}), /超时（系统繁忙）/, 'timeout'],
    ['unreadable', /安全软件拦截后重试/, 'failed'],
    [Object.assign(new Error(),{code:'EACCES'}), /辅助组件缺失或被安全软件拦截/, 'failed'],
  ]) {
    response = data;
    await assert.rejects(runDiagnostic('switch','codex','manual',undefined,windows.windowsCodexProcesses),message);
    const r = exportDiagnostics().operations.at(-1);
    assert.deepEqual([r.result,r.steps.map(s=>s.step)], [result,['process-unknown']]);
  }
});

test('Windows recovery needs both boot records to change and preserves a pending write after reboot', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-boot-test-'));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  asWindows(t);
  t.mock.method(os, 'homedir', () => root);
  t.mock.method(os, 'tmpdir', () => root);
  const boot = t.mock.method(windows, 'windowsBoot', async () => '12:133820340000000002');
  t.mock.method(process, 'kill', pid => {
    assert.equal(pid, 301);
    throw Object.assign(new Error('fixture process has exited'), { code:'ESRCH' });
  });
  await Promise.all([temp.initializeTemporaryBoot(), temp.initializeTemporaryBoot()]);
  for (const [prior, pending, removed] of [
    ['11:133810240000000000', false, true], ['11:133810240000000000', true, false],
    ['11:133820340000000000', false, false], // A prior WMI receipt omitted the last 100ns digit.
    ['11:133820340000000002', false, false], ['12:133820340000000001', false, false], [undefined, false, false],
  ]) {
    const directory = temp.createTemporaryCredentials('quota');
    const file = path.join(directory,'.ags-temporary-owner.json');
    const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(owner.windowsBoot, '12:133820340000000002');
    fs.writeFileSync(file, JSON.stringify({ ...owner, pid:301, windowsBoot:prior, pendingCommit:pending, processes:[{pid:302,group:false}] }));
    fs.writeFileSync(path.join(directory, 'auth.json'), 'fixture');
    assert.equal(temp.reapTemporaryCredentials().removed.includes(directory), removed);
    assert.equal(fs.existsSync(path.join(directory, 'auth.json')), !removed);
  }
  assert.equal(boot.mock.callCount(), 1);
});

test('Windows native inventory reports disposable Codex and Antigravity CLI processes for the current user', {
  skip: process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true',
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-session-test-'));
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  const system = path.join(process.env.SystemRoot,'System32');
  const psEnv = { ...process.env, AGS_TEST_SIGNED_EXE: process.execPath };
  delete psEnv.PSModulePath;
  const expected = cp.execFileSync(path.join(system,'WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',
    '$sig = Get-AuthenticodeSignature -LiteralPath $env:AGS_TEST_SIGNED_EXE; if ($sig.Status -ne "Valid") { exit 1 }; $sig.SignerCertificate.GetNameInfo("SimpleName",$false)'],
    {encoding:'utf8',timeout:20000,env:psEnv}).trim();
  assert.ok(expected);
  assert.equal(await windows.desktopCommand(['publisher', process.execPath],10000),expected);
  const unsigned = require('../dist/windows-helper').windowsHelper('DesktopWindows');
  assert.equal(await windows.desktopCommand(['publisher', unsigned]), '');
  const counter = cp.spawnSync(path.join(system,'reg.exe'),['query',
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters','/v','BootId'],{encoding:'utf8'});
  const bootId = /BootId\s+REG_DWORD\s+0x([a-f\d]+)/i.exec(counter.stdout || '');
  if (bootId && parseInt(bootId[1],16)) {
    const boot = await windows.windowsBoot();
    assert.match(boot,/^\d+:[1-9]\d{15,18}$/);
    assert.equal(Number(boot.split(':')[0]),parseInt(bootId[1],16));
    assert.equal(await windows.windowsBoot(),boot);
  }
  for (const [name, scan] of [['codex-app-server.exe', windows.windowsCodexProcesses], ['agy.exe', () => windows.windowsAntigravitySessions(new Set())]]) {
    const binary = path.join(directory, name);
    fs.copyFileSync(process.execPath, binary);
    const child = cp.spawn(binary, ['-e', 'console.log("ready"); setInterval(()=>{},1000)'], { stdio:['ignore','pipe','ignore'], windowsHide:true });
    const exited = once(child, 'exit');
    try {
      await once(child.stdout, 'data');
      assert.ok((await scan()).includes(child.pid));
    } finally { child.kill(); await exited; }
  }
});

test('Windows native inventory discovers the Electron desktop tree and closes only its root windows', {
  skip: process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted',
  timeout: 90000,
}, async t => {
  const desktop = require('../dist/windows-desktop');
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ags-windows-desktop-')));
  t.after(() => fs.rmSync(root, {recursive:true, force:true, maxRetries:3, retryDelay:200}));
  const local = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;
  t.after(() => { if (local === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = local; });
  const installed = path.join(root, 'Programs', 'OpenAI', 'Codex');
  fs.cpSync(path.dirname(require('electron')), installed, {recursive:true, mode: fs.constants.COPYFILE_FICLONE});
  const exe = path.join(installed, 'Codex.exe');
  fs.renameSync(path.join(installed, 'electron.exe'), exe);
  const app = path.join(installed, 'resources', 'app');
  fs.mkdirSync(app); fs.writeFileSync(path.join(app, 'package.json'), '{"name":"ags-desktop-fixture","main":"main.cjs"}');
  fs.writeFileSync(path.join(app,'main.cjs'), `const {app,BrowserWindow} = require('electron'), fs=require('node:fs'), path=require('node:path');
    app.disableHardwareAcceleration();
    const windows=[];
    app.whenReady().then(async()=>{
      for (let i=0;i<2;i++) {
        const win=new BrowserWindow({show:false,skipTaskbar:true,webPreferences:{sandbox:true}}); windows.push(win);
        win.on('closed',()=>fs.appendFileSync(path.join(__dirname,'events'),String(i)));
        await win.loadURL('data:text/html,fixture');
      }
      fs.writeFileSync(path.join(__dirname,'ready'), JSON.stringify(windows.map(w=>w.webContents.getOSProcessId())));
    }); app.on('window-all-closed',()=>app.quit());`);
  const child = cp.spawn(exe,['--user-data-dir='+path.join(root,'private-desktop')],{stdio:'ignore',windowsHide:true});
  const exited = once(child,'exit');
  try {
    for (let i=0; !fs.existsSync(path.join(app,'ready')); i++) {
      assert.ok(i < 200 && child.exitCode === null,'disposable Electron did not create windows');
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    const rows = await desktop.windowsDesktop('Codex'), renderers = JSON.parse(fs.readFileSync(path.join(app,'ready')));
    assert.ok(rows.some(p => p.pid === child.pid && p.file?.toLowerCase() === exe.toLowerCase()));
    assert.ok(renderers.every(pid => rows.some(p => p.pid === pid && p.created)));
    // At the final OS boundary only allow closing this fixture and verify its
    // renderers are wait-only. Run the real compiled helper after these checks.
    const main = rows.find(row => row.pid === child.pid), exec = cp.execFile;
    let verified = false;
    t.mock.method(cp, 'execFile', new Proxy(exec, { apply(target, receiver, values) {
      const [command, args] = values;
      if (path.basename(command).toLowerCase() === 'desktopwindows.exe' && args[0] !== 'processes') {
        assert.equal(args[0].toLowerCase(), exe.toLowerCase());
        assert.deepEqual(args.filter(arg => arg.startsWith('window:')), [`window:${main.pid}:${main.created}`]);
        assert.ok(renderers.every(pid => args.some(arg => arg.startsWith(`wait:${pid}:`))));
        verified = true;
      }
      return Reflect.apply(target, receiver, values);
    } }));
    const confirmed = await desktop.runningWindowsClients('Codex');
    await desktop.quitWindowsDesktop('Codex', confirmed);
    assert.equal(verified, true);
    assert.equal((await exited)[0],0);
    assert.deepEqual([...fs.readFileSync(path.join(app,'events'),'utf8')].sort(),['0','1']);
  } finally { if (child.exitCode === null) { child.kill(); await exited; } }
});
