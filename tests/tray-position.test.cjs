const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');

test('tray panel stays on the opening display through content changes and follows the next click', t => {
  const displays = [-1440, 0].map((x, id) => ({
    id, bounds: { x, y: 0, width: 1440, height: 900 }, workArea: { x, y: 24, width: 1440, height: 876 },
  }));
  const sideIcon = { x: -340, y: 0, width: 20, height: 24 };
  const mainIcon = { ...sideIcon, x: 1120 };
  let icon = sideIcon, cursor = { x: -330, y: 12 }, bounds, visible, generation;
  const handlers = new Map(), tray = new EventEmitter(), contents = new EventEmitter();
  contents.setWindowOpenHandler = () => {};
  contents.send = (_channel, _state, _reset, opening) => { generation = opening; };
  tray.setIgnoreDoubleClickEvents = () => {};
  tray.getBounds = () => icon;
  const displayAt = ({ x }) => displays[x < 0 ? 0 : 1];
  class Panel extends EventEmitter {
    webContents = contents;
    setVisibleOnAllWorkspaces() {}
    async loadFile(file) { contents.mainFrame = { url: pathToFileURL(file).href }; }
    setBounds(rect) { bounds = rect; }
    isVisible() { return visible; }
    show() { visible = true; }
    hide() { visible = false; }
    focus() {}
  }
  const electron = {
    BrowserWindow: Panel, ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    screen: { getDisplayMatching: displayAt, getDisplayNearestPoint: displayAt, getCursorScreenPoint: () => cursor },
  };
  const load = Module._load;
  const mock = t.mock.method(Module, '_load', function(name, ...args) {
    return name === 'electron' ? electron : load.call(this, name, ...args);
  });
  const { createTrayPanel } = require('../dist/tray-menu');
  mock.mock.restore();
  createTrayPanel(tray, () => undefined, () => {});
  const invoke = (name, ...args) => handlers.get('tray-panel-' + name)({ sender: contents, senderFrame: contents.mainFrame }, ...args);
  tray.emit('click', {}, sideIcon, { x: 10, y: 12 });
  invoke('ready');
  invoke('resize', 140, generation);
  const initial = { ...bounds };
  assert.ok(initial.x >= -1440 && initial.x + initial.width <= 0);

  // The other menu bar becomes active while the renderer measures a different tab or list.
  icon = mainIcon;
  cursor = { x: 1130, y: 12 };
  invoke('resize', 225, generation);
  assert.deepEqual(bounds, { ...initial, height: 225 });
  invoke('close', generation);
  tray.emit('right-click', {}, mainIcon);
  invoke('resize', 140, generation);
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 1440);

  // The native icon rect can still point to the previous screen at the next opening.
  invoke('close', generation);
  cursor = { x: -330, y: 12 };
  tray.emit('right-click', {}, mainIcon);
  invoke('resize', 140, generation);
  assert.ok(bounds.x <= cursor.x && cursor.x < bounds.x + bounds.width && bounds.x + bounds.width <= 0);
});
