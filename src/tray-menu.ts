import { BrowserWindow, ipcMain, screen, type Tray } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type TrayAgent = 'codex' | 'agy';
const panelWidth = 260;
export interface TrayAccount {
  name: string;
  label: string;
  plan?: string;
  windows: { label: string; remaining?: number }[];
  cached?: boolean;
  expired: boolean;
}
export interface TrayGroup {
  id: TrayAgent;
  current?: TrayAccount;
  unmanaged: boolean;
  canRefresh?: boolean;
  unavailable?: string;
  alternates: TrayAccount[];
  total: number;
}
export interface TraySnapshot {
  groups: TrayGroup[];
  refreshing: boolean;
  switching?: boolean;
  selectedAgent?: TrayAgent;
  windowClosed?: boolean;
}
export interface TrayCommand {
  action: 'open' | 'add' | 'switch' | 'update' | 'save' | 'refresh' | 'quit';
  agent?: TrayAgent;
  name?: string;
}

function allowed(command: TrayCommand, state?: TraySnapshot): boolean {
  if (!command || typeof command !== 'object') return false;
  const group = state?.groups.find(item => item.id === command.agent);
  switch (command.action) {
    case 'open': case 'quit': return true;
    case 'add': return !command.agent || !!group;
    case 'save': return !!group?.unmanaged;
    case 'refresh': return !state?.refreshing && !!state?.groups.some(item => item.canRefresh !== false && (item.current || item.unmanaged));
    case 'switch': return !state?.switching && !!group?.alternates.some(row => row.name === command.name && !row.expired);
    case 'update': return !!group?.current?.expired && group.current.name === command.name;
    default: return false;
  }
}

export function createTrayPanel(tray: Tray, snapshot: () => TraySnapshot | undefined, dispatch: (command: TrayCommand) => void) {
  const file = path.join(__dirname, '..', 'renderer', 'tray.html');
  let panel: BrowserWindow | undefined;
  let anchor: { icon: Electron.Rectangle; workArea: Electron.Rectangle } | undefined;
  let ready = false, requested = false, trayBlurAt = 0, pressedWhileOpen = false;
  let opening = 0;

  function publish(reset = false) {
    if (requested && ready) panel?.webContents.send('tray-panel-state', snapshot() ?? { groups: [], refreshing: false }, reset, opening);
  }
  function hide() {
    requested = false;
    anchor = undefined;
    panel?.hide();
  }
  function toggle(_event: Electron.KeyboardEvent, bounds?: Electron.Rectangle) {
    const closeOnRelease = pressedWhileOpen;
    pressedWhileOpen = false;
    if (requested || closeOnRelease) { hide(); trayBlurAt = 0; return; }
    // AppKit may blur the panel at mouse-down before delivering the status item's click.
    // If another AGS window now has focus, its activation already dismissed the panel.
    if (trayBlurAt && Date.now() - trayBlurAt < 400 && !BrowserWindow.getFocusedWindow()) { trayBlurAt = 0; return; }
    trayBlurAt = 0;
    const icon = bounds?.width && bounds.height ? bounds : tray.getBounds();
    const mouse = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(mouse);
    const menuHeight = Math.max(display.workArea.y - display.bounds.y, icon.height, 1);
    const overMenuBar = mouse.y >= display.bounds.y && mouse.y < display.bounds.y + menuHeight;
    // A mirrored status item can report the other screen's icon. Use the click on the menu bar in that case.
    const iconDisplay = screen.getDisplayMatching(icon);
    if (icon.width > 0 && icon.height > 0 && (display.id === iconDisplay.id || !overMenuBar)) {
      anchor = { icon, workArea: iconDisplay.workArea };
    } else {
      const width = Math.max(1, icon.width);
      anchor = { icon: { x: mouse.x - Math.floor(width / 2), y: display.bounds.y, width, height: menuHeight }, workArea: display.workArea };
    }
    requested = true;
    opening++;
    if (panel) { publish(true); return; }
    const win = new BrowserWindow({
      type: 'panel', width: panelWidth, height: 200, frame: false, show: false, resizable: false,
      minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
      roundedCorners: true, backgroundColor: '#ffffff', alwaysOnTop: true,
      webPreferences: { preload: path.join(__dirname, 'tray-preload.js'), sandbox: true, nodeIntegration: false, contextIsolation: true },
    });
    panel = win;
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('render-process-gone', () => win.destroy());
    win.on('blur', () => {
      if (!requested || !anchor) return;
      const mouse = screen.getCursorScreenPoint(), { icon } = anchor;
      if (mouse.x >= icon.x && mouse.x < icon.x + icon.width && mouse.y >= icon.y && mouse.y < icon.y + icon.height) trayBlurAt = Date.now();
      hide();
    });
    win.on('closed', () => { panel = undefined; anchor = undefined; ready = false; requested = false; });
    void win.loadFile(file).catch(() => { if (!win.isDestroyed()) win.destroy(); });
  }
  tray.setIgnoreDoubleClickEvents(true);
  tray.on('mouse-down', () => { pressedWhileOpen = requested; });
  tray.on('click', toggle);
  tray.on('right-click', toggle);

  function fromPanel(event: Electron.IpcMainInvokeEvent) {
    return panel && event.sender === panel.webContents && event.senderFrame === event.sender.mainFrame &&
      event.senderFrame.url === pathToFileURL(file).href;
  }
  ipcMain.handle('tray-panel-ready', event => {
    if (!fromPanel(event)) return;
    ready = true;
    publish(true);
  });
  ipcMain.handle('tray-panel-resize', (event, size: number, generation: number) => {
    if (!fromPanel(event) || !panel || !anchor || !requested || generation !== opening || !Number.isFinite(size)) return;
    const { icon, workArea } = anchor;
    const width = Math.min(panelWidth, workArea.width);
    const height = Math.min(workArea.height, Math.max(1, Math.ceil(size)));
    const x = Math.max(workArea.x, Math.min(Math.round(icon.x + (icon.width - width) / 2), workArea.x + workArea.width - width));
    const y = Math.max(workArea.y, Math.min(icon.y + icon.height + 4, workArea.y + workArea.height - height));
    panel.setBounds({ x, y, width, height });
    if (!panel.isVisible()) { panel.show(); panel.focus(); }
  });
  ipcMain.handle('tray-panel-close', (event, generation: number) => {
    if (fromPanel(event) && generation === opening) hide();
  });
  ipcMain.handle('tray-panel-action', (event, command: TrayCommand, generation: number) => {
    if (!fromPanel(event) || !requested || generation !== opening || !panel?.isVisible() || !allowed(command, snapshot())) return;
    if (command.action !== 'refresh' && command.action !== 'switch') hide();
    dispatch(command);
  });
  return { update: () => publish(), hide };
}
