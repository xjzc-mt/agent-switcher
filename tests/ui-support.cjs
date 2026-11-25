const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow } = require('electron');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const renderer = process.env.AGS_UI_RENDERER_ROOT || path.join(__dirname, '../renderer');

module.exports = function suite(options, verify) {
  return async function runSuite(name) {
    const { additionalArguments, ...windowOptions } = options;
    const window = new BrowserWindow({
      width: 880, height: 740, show: false, ...windowOptions,
      webPreferences: {
        preload: path.join(__dirname, 'fixture-preload.cjs'), partition: 'ags-ui-' + name,
        contextIsolation: true, backgroundThrottling: false, additionalArguments,
      },
    });
    const run = script => window.webContents.executeJavaScript(script);
    const errors = [];
    window.webContents.on('console-message', event => {
      if (event.level === 'error' && !/^ResizeObserver loop /i.test(event.message)) errors.push(event.message);
    });
    const until = async expression => {
      for (let i = 0; i < 100; i++) {
        if (await run(expression)) return;
        await pause(20);
      }
      throw new Error('Timed out: ' + expression);
    };
    const capture = async (file, force = false) => {
      if (!force && process.env.AGS_UI_SCREENSHOTS !== '1') return;
      const directory = path.join(__dirname, '../test-results/ui');
      fs.mkdirSync(directory, { recursive: true });
      const image = await window.webContents.capturePage();
      fs.writeFileSync(path.join(directory, file.endsWith('.png') ? file : file + '.png'), image.toPNG());
    };
    const load = async () => {
      await window.loadFile(path.join(renderer, 'index.html'));
      await until("document.querySelector('[data-account-context]') !== null");
    };
    try {
      await verify({ window, run, until, load, capture, pause,
        click: selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`) });
      assert.deepEqual(errors, [], 'Renderer errors in ' + name);
    } catch (error) {
      try { await capture(name + '-failure.png', true); }
      catch (captureError) { console.error('Could not capture failed suite', captureError); }
      throw error;
    } finally {
      for (const open of BrowserWindow.getAllWindows()) open.destroy();
    }
  };
};
