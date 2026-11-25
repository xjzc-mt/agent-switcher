const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const suites = [
  'smoke', 'layout', 'account-groups', 'refresh', 'interactions', 'chrome', 'rename',
  'account-errors-import', 'account-actions', 'cleanup', 'credential-batch', 'providers', 'app-updates',
];
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-ui-'));
if (process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain');
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.setPath('logs', path.join(userData, 'logs'));
app.setPath('crashDumps', path.join(userData, 'crashes'));
process.on('exit', () => fs.rmSync(userData, { recursive: true, force: true }));
app.on('window-all-closed', () => {}); // Each suite gets a fresh window; keep the runner alive.

app.whenReady().then(async () => {
  for (const name of suites) {
    try { await require('./ui-' + name + '.cjs')(name); }
    catch (error) { throw new Error('UI suite failed: ' + name, { cause: error }); }
    console.log('PASS ' + name);
  }
  console.log('Passed ' + suites.length + ' UI suites');
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
