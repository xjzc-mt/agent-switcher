import { BrowserWindow, ipcMain, Notification, screen, type Tray } from 'electron';
import type { MenuAction, MenuView } from './application-menu';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

type TrayAgent = 'codex' | 'agy';
const panelWidth = 260;
export interface TrayAccount {
  name: string;
  label: string;
  plan?: string;
  weeklyPro: boolean;
  windows: { label: string; usedPercent?: number; invalidated: boolean; resetsAt?: number }[];
  cached?: boolean;
  expired: boolean;
}
export interface TrayGroup {
  id: TrayAgent;
  current?: TrayAccount;
  unmanaged: boolean;
  canRefresh?: boolean;
  hasTargets?: boolean;
  refreshing?: boolean;
  bulkRefreshing?: boolean;
  unavailable?: string;
  alternates: TrayAccount[];
  total: number;
}
export interface TraySnapshot {
  groups: TrayGroup[];
  switching?: boolean;
  selectedAgent?: TrayAgent;
  countdown?: boolean;
  menu?: MenuView;
}
export interface TrayCommand {
  action: 'open' | 'add' | 'switch' | 'update' | 'save' | 'refresh' | 'quit';
  agent?: TrayAgent;
  name?: string;
  request?: string;
  decision?: { token: string; saveUnmanaged?: boolean };
}

export type WindowCommand = TrayCommand | { action: 'menu'; operation: MenuAction };

function allowed(command: TrayCommand, state?: TraySnapshot): boolean {
  if (!command || typeof command !== 'object') return false;
  const group = state?.groups.find(item => item.id === command.agent);
  switch (command.action) {
    case 'open': case 'quit': return true;
    case 'add': return !command.agent || !!group;
    case 'save': return !!group?.unmanaged;
    case 'refresh': return !!group?.hasTargets && !group.bulkRefreshing && !state?.switching && !state?.menu?.blocked;
    case 'switch': return !state?.switching && !!group?.alternates.some(row => row.name === command.name && !row.expired);
    case 'update': return !!group?.current?.expired && group.current.name === command.name;
    default: return false;
  }
}

export function createTrayPanel(tray: Tray, snapshot: () => TraySnapshot | undefined, dispatch: (command: TrayCommand) => void, onOpen?: (platform: TrayAgent) => void) {
  const file = path.join(__dirname, '..', 'renderer', 'tray.html');
  let panel: BrowserWindow | undefined;
  let anchor: { icon: Electron.Rectangle; workArea: Electron.Rectangle } | undefined;
  let ready = false, requested = false, pressedWhileOpen = false, dismissRelease = false;
  let opening = 0;
  let pending: { request: string; generation: number; resolve: (reply: unknown) => void } | undefined;
  function replySwitch(request: string, reply: { error?: string; warning?: string }) {
    if (!pending || pending.request !== request) return;
    const message = reply.error || reply.warning;
    if (message && (!requested || opening !== pending.generation) && Notification.isSupported())
      new Notification({ title:'账号切换', body:message }).show();
    pending.resolve(reply);
    pending = undefined;
  }
  function cancelSwitch() {
    if (pending) replySwitch(pending.request, { error: '账号窗口已重新连接，请核对当前账号后重试' });
  }

  function publish(reset = false) {
    if (requested && ready) panel?.webContents.send('tray-panel-state', snapshot() ?? { groups: [] }, reset, opening);
  }
  function hide() {
    pressedWhileOpen = false;
    requested = false;
    anchor = undefined;
    panel?.hide();
  }
  function toggle(_event: Electron.KeyboardEvent, bounds?: Electron.Rectangle) {
    const closeOnRelease = pressedWhileOpen || dismissRelease;
    pressedWhileOpen = false;
    dismissRelease = false;
    if (requested || closeOnRelease) { hide(); return; }
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
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.meta && !input.control && !input.alt && !input.shift && input.key.toLowerCase() === 'r') {
        event.preventDefault();
        if (!input.isAutoRepeat) win.webContents.send('tray-panel-refresh');
      }
    });
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('render-process-gone', () => win.destroy());
    win.on('blur', () => {
      // A native status-item release can follow blur without another mouse-down.
      // A fresh press or a new entry onto the icon ends that gesture.
      if (requested && anchor) {
        const { x, y } = screen.getCursorScreenPoint(), icon = anchor.icon;
        dismissRelease = pressedWhileOpen || (x >= icon.x && x < icon.x + icon.width && y >= icon.y && y < icon.y + icon.height);
      }
      hide();
    });
    win.on('closed', () => { panel = undefined; ready = false; dismissRelease = false; hide(); });
    void win.loadFile(file).catch(() => { if (!win.isDestroyed()) win.destroy(); });
  }
  tray.setIgnoreDoubleClickEvents(true);
  tray.on('mouse-down', () => { dismissRelease = false; pressedWhileOpen = requested; });
  tray.on('mouse-enter', () => { dismissRelease = false; });
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
    if (!panel.isVisible()) {
      panel.show();
      panel.focus();
      onOpen?.(snapshot()?.selectedAgent ?? 'codex');
    }
  });
  ipcMain.handle('tray-panel-close', (event, generation: number) => {
    if (fromPanel(event) && generation === opening) hide();
  });
  ipcMain.handle('tray-panel-action', (event, command: TrayCommand, generation: number) => {
    if (!fromPanel(event) || !requested || generation !== opening || !panel?.isVisible() || !allowed(command, snapshot()))
      return { error: '账号状态已变化，请重新选择' };
    if (command.action === 'switch') {
      if (pending) return { error: '另一项切换正在进行' };
      const request = randomUUID();
      return new Promise(resolve => {
        pending = { request, generation, resolve };
        try { dispatch({ ...command, request }); }
        catch { cancelSwitch(); }
      });
    }
    if (command.action !== 'refresh') hide();
    dispatch(command);
  });
  function refreshIfVisible() {
    if (!requested || !panel?.isVisible()) return false;
    panel.webContents.send('tray-panel-refresh');
    return true;
  }
  return { update: () => publish(), hide, replySwitch, cancelSwitch, refreshIfVisible };
}
