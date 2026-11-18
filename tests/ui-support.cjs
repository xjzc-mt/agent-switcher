const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

// Each UI suite owns its browser state, including when run on its own.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-ui-'));
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.setPath('logs', path.join(userData, 'logs'));
app.setPath('crashDumps', path.join(userData, 'crashes'));
process.on('exit', () => fs.rmSync(userData, { recursive: true, force: true }));

module.exports = function outputPath(name) {
  const directory = path.join(__dirname, '..', 'test-results', 'ui');
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, name);
};
